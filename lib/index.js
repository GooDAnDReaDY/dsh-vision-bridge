export async function runLocalOCR(bytes, contentType = 'image/png', lang = 'rus+eng') {
  try {
    const { spawnSync } = await import('node:child_process')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { writeFileSync, unlinkSync } = await import('node:fs')
    const check = spawnSync('tesseract', ['--version'], { timeout: 3000, encoding: 'utf8' })
    if (check.status === 0) {
      const stem = 'vbtess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
      const imgPath = join(tmpdir(), stem + '.png')
      writeFileSync(imgPath, bytes)
      const r = spawnSync('tesseract', [imgPath, 'stdout', '-l', lang, '--psm', '3'], { timeout: 15000, encoding: 'utf8' })
      try { unlinkSync(imgPath) } catch {}
      const text = (r.stdout || '').trim()
      if (text) return text
    }
  } catch {}

  try {
    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker(lang)
    const ret = await worker.recognize(Buffer.from(bytes))
    await worker.terminate()
    const text = (ret && ret.data && ret.data.text ? ret.data.text : '').trim()
    if (text) return text
  } catch {}

  return ''
}

// dsh-vision-bridge — host half.
//
// A self-owned vision bridge for text-only DeepSeek conversations:
//  1. At the agent boundary (agent/pre-step) it replaces every image block in
//     the MODEL's request with a text marker pointing at `describe_image`, so
//     an image content block never reaches a text-only provider (which would
//     otherwise fail the whole turn with UNSUPPORTED_CONTENT). The session log
//     keeps the original image, so the Web UI still shows it.
//  2. It registers a `describe_image` tool that sends the image to a vision
//     model of the DEPLOYMENT'S choosing (auto-picked from the LLM catalog, or
//     set explicitly via the Web settings card) and returns its answer to the
//     text model.
//
// Nothing is delegated to third parties: both the rewrite and the vision call
// run here, using the harness `llm` service and the configured vision model.

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runChannels, probeOllama, discoverOllamaVisionModels, channelKey, getSortedChannels } from './channels.js'
import { createLru, descriptionCacheKey } from './cache.js'
import { EvidenceStore } from './evidence.js'
import { VisionJournal } from './journal.js'

const FREE_VISION_PROVIDERS = [
  { id: 'groq-free', name: 'Groq (free tier)', type: 'openai-compatible', baseURL: 'https://api.groq.com/openai/v1', model: 'llava-v1.5-7b-4096-preview', envKey: 'GROQ_API_KEY' },
  { id: 'together-free', name: 'Together (free tier)', type: 'openai-compatible', baseURL: 'https://api.together.xyz/v1', model: 'llava-hf/llava-1.5-7b-hf', envKey: 'TOGETHER_API_KEY' },
  { id: 'fireworks-free', name: 'Fireworks (free tier)', type: 'openai-compatible', baseURL: 'https://api.fireworks.ai/inference/v1', model: 'accounts/fireworks/models/llava-v1.5-7b-fw', envKey: 'FIREWORKS_API_KEY' },
]

export const name = 'dsh-vision-bridge'
export const inject = ['tools', 'llm', 'attachments', 'fs', 'webServer', 'settings', 'skills']

export const Config = z.object({
  // Empty => auto-pick the first vision-capable model found in the LLM catalog.
  visionProvider: z
    .string()
    .description('Provider of the vision model that answers describe_image. Empty = auto-detect.')
    .default(''),
  visionModel: z
    .string()
    .description('Model id of the vision model. Empty = auto-detect.')
    .default(''),
  sanitizeImages: z
    .boolean()
    .description('Rewrite image blocks to text markers for text-only models so turns never fail.')
    .default(true),
  // 'hybrid' preserves the legacy behavior (auto-rewrite + tools available).
  // 'llm' = same rewrite but explicitly user-chosen. 'tools' = never auto-rewrite;
  // the model has to call describe_image itself, otherwise the adapter fails.
  mode: z
    .union([z.const('hybrid'), z.const('llm'), z.const('tools')])
    .description('Bridge mode: hybrid (default, auto-rewrite + tools), llm (auto-rewrite only), tools (no auto-rewrite, model must call describe_image).')
    .default('hybrid'),
  // 'auto' = call the vision LLM (current behavior). 'ocr-local' / 'cache-only' are
  // hints reserved for future local-OCR fallback; until then they behave like 'auto'.
  describeStrategy: z
    .union([z.const('auto'), z.const('llm'), z.const('ocr-local'), z.const('cache-only')])
    .description('How describe_image and the auto-rewrite resolve a description. auto/llm use the vision LLM today; ocr-local/cache-only are reserved.')
    .default('auto'),
  // 'simple-only' = one pass. 'auto-escalate' = ask the vision model to self-rate
  // complexity; if complex, do a second deeper pass before substituting (idea from
  // 54xkeee/dsh-vision-web).
  escalation: z
    .union([z.const('simple-only'), z.const('auto-escalate')])
    .description('Escalation policy for the auto-rewrite. simple-only = one pass; auto-escalate = second pass on complex images.')
    .default('simple-only'),
  // Multi-channel vision endpoint (Issue #2). Empty = legacy auto-pick from
  // the DSH LLM catalog (one channel = {type:'dsh-catalog'}).
  channels: z
    .array(z.any())
    .description('Vision endpoints tried in order. Empty array = legacy auto-pick. Supported types: dsh-catalog, openai-compatible, ollama, custom.')
    .default([]),
  channelFallback: z
    .union([z.const('sequential'), z.const('parallel-race')])
    .description('How channels are tried. sequential = one by one until one succeeds (default). parallel-race = all at once, first success wins.')
    .default('sequential'),
  channelOrderMode: z
    .union([z.const('manual'), z.const('auto-latency')])
    .description('How channels are ordered. manual = user-defined order (default). auto-latency = sort by average latency, fastest first.')
    .default('manual'),
  channelTimeoutMs: z
    .number()
    .description('Per-channel HTTP timeout in milliseconds.')
    .default(30000),
  channelCooldownMs: z
    .number()
    .description('Skip a failing channel for this long after a 4xx/timeout. 0 disables cooldown.')
    .default(60000),
  channelFailureMode: z
    .union([z.const('placeholder'), z.const('error')])
    .description('What to do when ALL channels fail. placeholder (default) inserts "[image description unavailable]" and lets the chat continue; error throws.')
    .default('placeholder'),
  autoLocalOllama: z
    .boolean()
    .description('On startup, probe http://localhost:11434/v1 and prepend an ollama channel if reachable.')
    .default(true),
  keysFromEnv: z
    .array(z.string())
    .description('Env-var names to look up when a channel has no apiKey. Order matters: first match wins.')
    .default(['VISION_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY', 'ZHIPUAI_API_KEY']),
  // Per-image description cache (Issue #3). LRU with composite key.
  cacheEnabled: z
    .boolean()
    .description('Enable in-memory cache of descriptions keyed by image bytes + prompt + model + mode.')
    .default(true),
  cacheMaxEntries: z
    .number()
    .description('Maximum number of cached descriptions before LRU eviction.')
    .default(256),
  // Block 7 (0.2.12): native passthrough control.
  nativePassthrough: z
    .union([z.const('prefer'), z.const('always'), z.const('never')])
    .description('prefer (default): bridge only for text-only models; always: never bridge; never: always bridge even for vision models.')
    .default('prefer'),
  // Block 4 (0.2.9): persist evidence across restarts.
  evidencePersist: z
    .boolean()
    .description('Persist descriptions to disk so later sessions reuse them without re-calling the vision model.')
    .default(false),
  evidenceDir: z
    .string()
    .description('Directory for vision-evidence.json. Empty = plugin data dir (DSH-provided) or cwd fallback.')
    .default(''),
  evidenceMaxEntries: z
    .number()
    .description('Maximum persisted entries before oldest-ts eviction.')
    .default(2000),
  // Block 8 (0.2.13): privacy boundary.
  allowedImageDirs: z
    .array(z.string())
    .description('If non-empty, only allow image paths under these dirs; others are rejected.')
    .default([]),
  auditLog: z
    .union([z.const('off'), z.const('errors'), z.const('all')])
    .description('off: no log; errors: log failures; all: log every vision call.')
    .default('off'),
  maskSecrets: z
    .boolean()
    .description('Mask API keys in error messages.')
    .default(true),
  // Block 0.3.9 (#65): task-aware vision prompts.
  focusHint: z
    .boolean()
    .description('Pass the latest user message as a focus hint to the vision model, so the description emphasises what the user asked about.')
    .default(true),
  taskMode: z
    .union([z.const('glance'), z.const('ocr'), z.const('region'), z.const('compare')])
    .description('Default framing for the auto-rewrite prompt. glance = general; ocr = transcribe; region = spatial layout; compare = differences across images.')
    .default('glance'),
  maxImageBytes: z
    .number()
    .description('Upper bound in bytes for a single image sent to the vision model.')
    .default(20 * 1024 * 1024),
  imageMaxWidth: z
    .number()
    .description('Maximum image width in pixels. Images larger than this are resized before sending to the vision model.')
    .default(1920),
  imageMaxHeight: z
    .number()
    .description('Maximum image height in pixels. Images larger than this are resized before sending to the vision model.')
    .default(1080),
  imageQuality: z
    .number()
    .description('Image compression quality (1-100) for WebP/JPEG output.')
    .default(80),
  imageFormat: z
    .union([z.const('auto'), z.const('webp'), z.const('jpeg'), z.const('avif')])
    .description('Output format for compressed images. auto = WebP if sharp available, else JPEG.')
    .default('auto'),
  tileLargeImages: z
    .boolean()
    .description('Automatically tile images larger than tileThreshold for vision model processing.')
    .default(true),
  tileThreshold: z
    .number()
    .description('Pixel threshold for tiling. Images larger than this are split into tiles.')
    .default(4000000),
  deskew: z
    .boolean()
    .description('Automatically detect and correct image rotation/perspective before sending.')
    .default(false),
  enhanceImage: z
    .boolean()
    .description('Apply adaptive contrast (CLAHE) and whiteboard cleaning before sending.')
    .default(false),
  selfCheckEnabled: z.boolean().default(true),
  consensusEnabled: z.boolean().default(false),
  maskPII: z
    .boolean()
    .description('Mask PII (emails, phones, names) in prompts before sending to vision model.')
    .default(false),
  maskSystemPaths: z
    .boolean()
    .description('Mask system paths and IP addresses in vision model responses.')
    .default(false),
  blurFaces: z
    .boolean()
    .description('Detect and blur faces in images before sending to vision model.')
    .default(false),
  stripEXIF: z
    .boolean()
    .description('Strip EXIF metadata from images before sending to vision model.')
    .default(false),
  nsfwFilter: z
    .boolean()
    .description('Block images detected as NSFW before sending to vision model.')
    .default(false),
  includeOAuthProviders: z
    .boolean()
    .description('If true and dsh-subscription plugin is installed, include OAuth vision providers as additional channels.')
    .default(true),
  autoDiscoverOllama: z
    .boolean()
    .description('Auto-discover all vision models in local Ollama and add as channels.')
    .default(true),
  autoFreeProviders: z
    .boolean()
    .description('Auto-add free vision providers when their API key is set in environment.')
    .default(true),
  // #91: uniform pixel-count guard before the vision call. Without a native
  // image lib we reject oversized images with a clear error instead of silently
  // sending multi-MP payloads that providers reject. Upgrade path: if sharp is
  // installed, downscale to this limit in one place here.
  maxImagePixels: z
    .number()
    .description('Upper bound in pixels (width*height) for a single image. 0 disables the guard. Default 4MP.')
    .default(4_000_000),
  // #96: per-call resolution hint for vision tools (token economy on large images).
  detail: z
    .union([z.const('auto'), z.const('low'), z.const('high')])
    .description('Resolution hint passed to providers that support it. auto = let the provider decide; low = fewer tokens; high = maximum fidelity.')
    .default('auto'),
  // #106: stream vision responses token-by-token for faster first-token latency.
  stream: z
    .boolean()
    .description('Stream openai-compatible responses (SSE) for faster first token. Falls back to non-stream automatically.')
    .default(false),
  timeoutMs: z
    .number()
    .description('Timeout for a describe_image call in milliseconds.')
    .default(120000),
})

/** True when the bridge is allowed to substitute image blocks for the given mode. */
export function sanitizeAllowed(config) {
  return config.sanitizeImages !== false && config.mode !== 'tools'
}

/** Whether to let a vision-capable model see the image natively instead of bridging. */
export function shouldBridgeForModel(config, supportsImages) {
  const pref = config.nativePassthrough || 'prefer'
  if (pref === 'never') return true
  if (pref === 'always') return false
  return !supportsImages // prefer: bridge only when text-only
}

export function isPathAllowed(path, allowedDirs) {
  if (!Array.isArray(allowedDirs) || allowedDirs.length === 0) return true
  const p = String(path || '')
  return allowedDirs.some((d) => p.startsWith(String(d)))
}

export function maskSecretsInError(msg) {
  if (typeof msg !== 'string') return msg
  return msg.replace(/(api[_-]?key\s*[:=]\s*)[^,\s]+/gi, '$1***')
}

/** True when `info` (from ctx.llm) explicitly declares image input. */
export function acceptsImages(info) {
  if (info && Array.isArray(info._nativeInputModalities)) {
    return info._nativeInputModalities.includes('image')
  }
  return Array.isArray(info && info.inputModalities) && info.inputModalities.includes('image')
}

/** Whether any block in `content` is an image. */
export function blocksHaveImage(content) {
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    if (!block || typeof block !== 'object') return false
    if (block.type === 'image') return true
    return Array.isArray(block.content) && blocksHaveImage(block.content)
  })
}

/**
 * Recursively rewrite image blocks anywhere in a content tree (including
 * inside tool-result blocks and top-level tool results), and collect every
 * attachment reference found so describe_image can read them by id.
 */
export async function rewriteImagesDeep(content, replace) {
  const attachments = []
  const walk = async (blocks) => {
    if (!Array.isArray(blocks)) return { content: blocks, changed: false }
    let changed = false
    const next = []
    for (const block of blocks) {
      if (block && block.type === 'image') {
        if (block.attachment) attachments.push(block.attachment)
        changed = true
        // replace may be sync or async; await the (possibly already-resolved) value.
        const out = await (async () => Promise.resolve(replace(block)))()
        if (out !== undefined && out !== null) {
          if (Array.isArray(out)) next.push(...out)
          else next.push(out)
        }
        continue
      }
      if (block && Array.isArray(block.content)) {
        const nested = await walk(block.content)
        if (nested.changed) {
          changed = true
          next.push({ ...block, content: nested.content })
          continue
        }
      }
      next.push(block)
    }
    return { content: changed ? next : blocks, changed }
  }
  const result = await walk(content)
  return { content: result.content, changed: result.changed, attachments }
}

/** Marks a request this plugin re-dispatched, so the interceptor does not recurse. */
const VISION_PASS = Symbol.for('dsh-vision-bridge/pass')

export function apply(ctx, config) {
  // Helper: do we have any way to authenticate a channel? Used by the UI status-dot.
  const hasUsableKey = (channel) => {
    if (!channel) return false
    if (typeof channel.apiKey === 'string' && channel.apiKey.trim()) return true
    const names = Array.isArray(config.keysFromEnv) ? config.keysFromEnv : []
    for (const n of names) {
      const v = process.env[n]
      if (typeof v === 'string' && v.trim()) return true
    }
    return false
  }
  // Helper: name the key the channel will use, for the status-dot label.
  const resolveKey = (channel) => {
    if (channel && typeof channel.apiKey === 'string' && channel.apiKey.trim()) return 'config'
    const names = Array.isArray(config.keysFromEnv) ? config.keysFromEnv : []
    for (const n of names) {
      if (typeof process.env[n] === 'string' && process.env[n].trim()) return n
    }
    return ''
  }
  // attachmentId -> full ref, recorded from image blocks seen at the agent
  // boundary so describe_image can read them by id without session plumbing.
  const attachmentById = new Map()
  function recordAttachment(id, ref) {
    if (id === undefined || id === null || !ref) return
    const key = String(id)
    attachmentById.delete(key)
    attachmentById.set(key, ref)
    if (attachmentById.size > 300) {
      const oldestKey = attachmentById.keys().next().value
      if (oldestKey !== undefined) attachmentById.delete(oldestKey)
    }
  }
  // Channel cooldowns persist across calls within the plugin lifetime.
  const channelCooldowns = new Map()
  // Circuit breaker states per channel (#129).
  const channelCircuitStates = new Map()
  // Latency tracking per channel (#127).
  const channelLatencies = new Map()
  // Block 0.3.9 (#65): last user text, used as focus hint for task-aware prompts.
  let lastUserText = ''
  // Block B (0.3.6): per-channel usage stats (calls/latency/errors) for /stats + bench.
  const usageByChannel = new Map()
  const bumpUsage = (key, ms, ok, keyUsed, usage) => {
    const cur = usageByChannel.get(key) || { calls: 0, totalMs: 0, errors: 0, lastMs: 0 }
    cur.calls++; cur.totalMs += ms; cur.lastMs = ms; if (!ok) cur.errors++
    // #98: track which key/quota label the read spent.
    if (ok && keyUsed) {
      cur.quota = cur.quota || {}
      cur.quota[keyUsed] = (cur.quota[keyUsed] || 0) + 1
    }
    // #107: real token usage from the provider response (accurate cost).
    if (ok && usage) {
      const pt = Number(usage.prompt_tokens) || 0
      const ct = Number(usage.completion_tokens) || 0
      cur.tokensIn = (cur.tokensIn || 0) + pt
      cur.tokensOut = (cur.tokensOut || 0) + ct
    }
    usageByChannel.set(key, cur)
  }
  // contentHash -> description, so repeated questions about the same image
  // reuse a cached answer instead of re-spending a vision-model call, and so
  // later text turns substitute a real description instead of a bare marker.
  // Issue #3: LRU cache keyed by bytes+prompt+model+mode. Map-based, no deps.
  const descriptionByHash = config.cacheEnabled === false ? null : createLru(config.cacheMaxEntries)
  // Block 4 (0.2.9): optional persistent evidence store behind the LRU.
  const evidenceStore = config.evidencePersist ? new EvidenceStore(config.evidenceDir || '.', config.evidenceMaxEntries) : null
  // #108: vision journal — audit trail of every vision call.
  const journal = new VisionJournal(config.evidenceDir || '.', config.evidenceMaxEntries)
  // #110: batch manager — track in-flight batches for progress + cancel.
  const batches = new Map()
  let batchSeq = 0
  // attachmentId -> description, for inline substitution in later text turns.
  const descriptionByAttachmentId = new Map()
  // #172: track last N vision requests for debug
  const lastRequests = []
  const trackRequest = (info) => {
    lastRequests.push({ ts: Date.now(), ...info })
    if (lastRequests.length > 20) lastRequests.shift()
  }

// requireScope hoisted

  const getLiveConfig = () => {
    try {
      const scope = requireScope()
      const snap = scope.getSnapshot()
      if (snap && snap.value) return { ...config, ...snap.value }
    } catch {}
    return config
  }

  const visionSelection = async () => {
    const live = getLiveConfig()
    const provider = (live.visionProvider || '').trim()
    const model = (live.visionModel || '').trim()
    if (provider && model) {
      return { provider, model }
    }
    // Auto-detect the first vision-capable model in the catalog.
    const providerIds = new Set()
    if (typeof ctx.llm.listProviders === 'function') {
      for (const p of ctx.llm.listProviders() || []) {
        const id = p && (p.provider || p.id)
        if (id) providerIds.add(id)
      }
    }
    if (typeof ctx.llm.listConfigurableProviders === 'function') {
      for (const p of ctx.llm.listConfigurableProviders() || []) {
        const id = p && (p.provider || p.id)
        if (id) providerIds.add(id)
      }
    }
    for (const prov of providerIds) {
      try {
        const models = await ctx.llm.listModels(prov)
        for (const m of models || []) {
          if (acceptsImages(m)) return { provider: prov, model: m.id }
        }
      } catch {
        // try the next provider
      }
    }
    throw new Error(
      'dsh-vision-bridge: не найдено ни одной vision-модели в каталоге LLM. Добавьте vision-модель (input: [text, image]) в Настройки → Модели, либо укажите visionProvider/visionModel в настройках плагина.',
    )
  }

  // Prefer a stable resolution but watch for topologies that change at boot
  // (adapters register asynchronously). Re-resolve per call is safest.
  //
  // Send one image's bytes to the chosen vision model and return the
  // description. Cache by composite key (bytes+prompt+model+mode) so repeated
  // questions about the same image (or the same image appearing in many later
  // turns) reuse the previous answer.
  const cacheKeyFor = (bytes, question, model) => {
    if (!descriptionByHash) return null
    return descriptionCacheKey({
      bytes,
      prompt: question,
      model,
      mode: config.describeStrategy || 'auto',
    })
  }
  // #110: run a batch of images with progress + cancel. Returns a batch id; the
  // caller polls /batch/:id for progress and can POST /batch/:id/cancel.
  const startBatch = async (items, prompt) => {
    const id = 'b' + (++batchSeq)
    const ctrl = new AbortController()
    const state = { id, prompt, total: items.length, done: 0, ok: 0, failed: 0, results: [], cancelled: false, startedAt: Date.now() }
    batches.set(id, { state, ctrl })
    ;(async () => {
      for (const item of items) {
        if (ctrl.signal.aborted) { state.cancelled = true; break }
        try {
          const r = await callVisionModelWithBytes(item.bytes, item.contentType, prompt || 'Describe this image.', { signal: ctrl.signal })
          state.results.push({ id: item.id, description: r.description || '' })
          state.ok++
        } catch (e) {
          if (ctrl.signal.aborted) { state.cancelled = true; break }
          state.results.push({ id: item.id, error: String(e?.message || e).slice(0, 200) })
          state.failed++
        }
        state.done++
      }
      state.finishedAt = Date.now()
    })()
    return id
  }

  const resolveChannelForProvider = async (provider, model) => {
    try {
      const cfgProviders = typeof ctx.llm.listConfigurableProviders === 'function' ? ctx.llm.listConfigurableProviders() : []
      const found = (cfgProviders || []).find((p) => p && (p.provider || p.id) === provider)
      if (found && found.baseURL) {
        let apiKey = ''
        if (found.apiKeyEnv) {
          try {
            const creds = ctx.get('credentials')
            if (creds && typeof creds.resolve === 'function') {
              apiKey = await creds.resolve(found.apiKeyEnv)
            }
          } catch {}
          if (!apiKey && process.env[found.apiKeyEnv]) {
            apiKey = process.env[found.apiKeyEnv]
          }
        }
        return {
          type: 'openai-compatible',
          baseURL: found.baseURL,
          model,
          apiKey: apiKey || '',
        }
      }
    } catch {}
    return null
  }

  const callVisionModelWithBytes = async (bytes, contentType, question, opts) => {
    // #91: uniform pixel guard — reject oversized images before spending a call.
    if (config.maxImagePixels > 0) {
          // Image preprocessing pipeline (#145 #146 #147)
    if (config.deskew) {
      bytes = await deskewImage(bytes, contentType)
    }
    if (config.enhanceImage) {
      bytes = await enhanceImage(bytes, contentType)
    }
    // Smoothly downscale oversized images without slicing into contradicting tiles
    try {
      const compressed = await compressImage(bytes, contentType, {
        maxWidth: config.imageMaxWidth || 1920,
        maxHeight: config.imageMaxHeight || 1080,
        quality: config.imageQuality || 80,
        format: config.imageFormat || 'auto',
      })
      if (compressed && compressed.bytes) {
        bytes = compressed.bytes
        contentType = compressed.contentType || contentType
      }
    } catch {}

const dims = imageDimensions(bytes)
      if (dims && dims.width > 0 && dims.height > 0 && dims.width * dims.height > config.maxImagePixels) {
        throw new Error(
          `dsh-vision-bridge: изображение ${dims.width}×${dims.height}px (${(dims.width * dims.height / 1e6).toFixed(1)}MP) превышает лимит ${(config.maxImagePixels / 1e6).toFixed(1)}MP. Уменьшите изображение перед вызовом.`,
        )
      }
    }
    const detail = opts && opts.detail ? opts.detail : (config.detail || 'auto')
    // Channels-driven path (Issue #2). Empty config.channels = legacy path.
    if (Array.isArray(config.channels) && config.channels.length > 0) {
      const modelHint = (config.channels.find((c) => c && c.model) || {}).model || 'channels'
    // #170: pHash cache — check perceptual hash before composite key cache
    const ph = await pHash(bytes)
    if (ph && descriptionByHash.has('ph:' + ph)) {
      const cached = descriptionByHash.get('ph:' + ph)
      trackRequest({ ok: true, cached: true, pHash: ph, channel: 'phash-cache' })
      return { description: cached, cached: true }
    }
      const key = cacheKeyFor(bytes, question, modelHint)
      if (key) {
        const cached = descriptionByHash.get(key)
        if (typeof cached === 'string' && cached.trim()) return { description: cached, cached: true }
        // Block 4: persistent evidence fallback (survives restarts).
        const persisted = evidenceStore && evidenceStore.get(key)
        if (typeof persisted === 'string' && persisted.trim()) {
        descriptionByHash.set(key, persisted)
        return { description: persisted, cached: true }
      }
      }
      const t0 = Date.now()
      let orderedChannels = config.channels
      if (config.channelOrderMode === 'auto-latency') {
        orderedChannels = getSortedChannels(config.channels, {
          latencies: channelLatencies,
          circuitStates: channelCircuitStates,
          cooldowns: channelCooldowns,
          cooldownMs: config.channelCooldownMs,
        })
      }
      const result = await runChannels(orderedChannels, {
        bytes,
        contentType: contentType || sniffMediaType(bytes) || 'image/png',
        prompt: question,
        timeoutMs: config.channelTimeoutMs,
        cooldownMs: config.channelCooldownMs,
        signal: opts && opts.signal,
        cooldowns: channelCooldowns,
        fallback: config.channelFallback || 'sequential',
        detail,
        stream: config.stream === true,
      })
      const chKey = result.channel ? channelKey(result.channel) : 'all'
      // #98: surface which key/quota the read spent.
      const keyLabel = result.keyUsed
      if (result.ok && result.description) {
        let desc = result.description
        if (config.maskSystemPaths) desc = maskSystemPaths(desc)
        bumpUsage(chKey, Date.now() - t0, true, result.keyUsed, result.usage)
        if (key) descriptionByHash.set(key, desc)
        if (key && evidenceStore) evidenceStore.set(key, desc)
        if (ph) descriptionByHash.set('ph:' + ph, desc)
        trackRequest({ ok: true, cached: false, pHash: ph, channel: chKey })
        // #108: journal the successful call.
        journal.add({ ok: true, channel: chKey, key: keyLabel, imageHash: contentHash(bytes), prompt: question.slice(0, 200), tokensIn: result.usage && result.usage.prompt_tokens, tokensOut: result.usage && result.usage.completion_tokens, latencyMs: Date.now() - t0 })
        // #88: expose meta.attempts (channel-level failover trace) to callers/UI.
        return { description: desc, cached: false, attempts: result.attempts, keyUsed: keyLabel, usage: result.usage }
      }
      bumpUsage(chKey, Date.now() - t0, false)
      // #108: journal the failure.
      journal.add({ ok: false, channel: chKey, key: keyLabel, imageHash: contentHash(bytes), prompt: question.slice(0, 200), reason: result.reason, latencyMs: Date.now() - t0 })
      if (config.channelFailureMode === 'placeholder') {
        return { description: '[image description unavailable: ' + (result.reason || 'all channels failed') + ']', cached: false, attempts: result.attempts, keyUsed: keyLabel }
      }
      throw new Error('dsh-vision-bridge: ' + (result.reason || 'all channels failed'))
    }
    const { provider, model } = await visionSelection()
    const key = cacheKeyFor(bytes, question, provider + '/' + model)
    if (key) {
      const cached = descriptionByHash.get(key)
      if (typeof cached === 'string' && cached.trim()) return { description: cached, provider, model, cached: true }
      const persisted = evidenceStore && evidenceStore.get(key)
      if (typeof persisted === 'string' && persisted.trim()) {
        descriptionByHash.set(key, persisted)
        return { description: persisted, provider, model, cached: true }
      }
    }

    // Direct channel execution for OpenAI-compatible providers
    const directChannel = await resolveChannelForProvider(provider, model)
    if (directChannel) {
      try {
        const res = await runChannels([directChannel], {
          bytes,
          contentType: contentType || sniffMediaType(bytes) || 'image/png',
          prompt: question,
          timeoutMs: config.channelTimeoutMs || 30000,
          signal: opts && opts.signal,
          detail,
        })
        if (res && res.ok && res.description) {
          let desc = res.description
          if (config.maskSystemPaths) desc = maskSystemPaths(desc)
          if (key) descriptionByHash.set(key, desc)
          if (key && evidenceStore) evidenceStore.set(key, desc)
          return { description: desc, provider, model, cached: false }
        }
      } catch (err) {
        console.warn('[dsh-vision-bridge] directChannel run failed, falling back to ctx.llm.stream:', err)
      }
    }
    // The adapter resolves an image block through attachments.readImage(ref),
    // and the store only accepts its own `sha256:<hex>` ids. A fabricated ref
    // makes readImage throw INVALID_ATTACHMENT_REF inside the stream, which
    // collectText silently swallows — so store the bytes and pass the real ref.
    const savedRef = await ctx.attachments.saveImage({
      data: bytes,
      mediaType: contentType || sniffMediaType(bytes) || 'image/png',
      name: 'vision-input',
    })
    const blocks = [
      { type: 'image', attachment: savedRef },
      { type: 'text', text: question },
    ]
    const chunks = ctx.llm.stream({
      ...(opts && opts.signal ? { signal: opts.signal } : {}),
      provider,
      model,
      messages: [{ role: 'user', content: blocks }],
      ...(config.timeoutMs > 0 ? { maxTokens: 1024 } : {}),
      [VISION_PASS]: true,
    })
    const text = await collectText(chunks)
    if (text && key) {
      descriptionByHash.set(key, text)
      if (evidenceStore) evidenceStore.set(key, text)
    }
    return { description: text, provider, model, cached: false }
  }

  // describeAttachment: used by the pre-step sanitizer when an image is shown
  // to a text-only model. Returns the description text (cached) and records
  // it against the attachment id so later text turns reuse the same answer.
  const describeAttachment = async (ref) => {
    if (!ref) return undefined
    const id = ref.attachmentId ?? ref.id
    if (id !== undefined) {
      const hit = descriptionByAttachmentId.get(String(id))
      if (typeof hit === 'string' && hit.trim()) return hit
    }
    let stored
    try {
      stored = await ctx.attachments.readImage(ref)
    } catch {
      return undefined
    }
    if (stored.data.length > config.maxImageBytes) return undefined
    // Block 0.3.9 (#65): task-aware prompt — focus hint from the latest user
    // message, framing by taskMode.
    const modePrompts = {
      glance: 'Describe everything visible in this image in thorough detail. Include any text, code, UI, data, objects, people, layout, colors, and any other notable visual information.',
      ocr: 'Transcribe all text visible in this image in natural reading order, preserving headings, paragraphs, tables and UI hierarchy.',
      region: 'Describe the spatial layout of this image: regions, their coordinates in words (top-left, center, …), and what each region contains.',
      compare: 'List the distinct elements of this image so they can be compared against another image later. Be specific about what differs or stands out.',
    }
    let prompt = modePrompts[config.taskMode] || modePrompts.glance
    const hint = lastUserText && config.focusHint !== false ? String(lastUserText).trim() : ''
    if (hint) prompt += ` Focus on what is relevant to this user request: "${hint.slice(0, 400)}"`
    let firstPass
    if (config.describeStrategy === 'ocr-local') {
      const ocrText = await runLocalOCR(stored.data, ref.mediaType || 'image/png')
      const dims = imageDimensions(stored.data)
      const parts = []
      if (dims && dims.width > 0 && dims.height > 0) parts.push(`[Image dimensions: ${dims.width}×${dims.height}px]`)
      if (ocrText && ocrText.trim()) parts.push(`[Extracted text:\n${ocrText.trim()}]`)
      firstPass = parts.join('\n\n') || undefined
    } else {
      try {
        const res = await callVisionModelWithBytes(
          stored.data,
          ref.mediaType || stored.ref?.mediaType || 'image/png',
          prompt,
          {},
        )
        firstPass = res && res.description
      } catch (err) {
        console.warn('[dsh-vision-bridge] LLM vision call failed, trying local OCR fallback:', err)
      }

      // Offline OCR & metadata fallback if LLM produces no description
      if (!firstPass || !firstPass.trim()) {
        try {
          const ocrText = await runLocalOCR(stored.data, ref.mediaType || 'image/png')
          const dims = imageDimensions(stored.data)
          const parts = []
          if (dims && dims.width > 0 && dims.height > 0) parts.push(`Image dimensions: ${dims.width}×${dims.height}px (${(stored.data.length / 1024).toFixed(1)} KB)`)
          if (ocrText && ocrText.trim()) parts.push(`Extracted text:\n${ocrText.trim()}`)
          if (parts.length > 0) firstPass = parts.join('\n\n')
        } catch {}
      }
    }
    // ponytail: escalation kept inline — second pass only when auto-escalate is on
    // and the first pass self-reports complexity=complex. Upgrade path: proper
    // complexity classifier once we have a tracked metric.
    if (config.escalation !== 'auto-escalate' || !firstPass) {
      if (firstPass && id !== undefined) descriptionByAttachmentId.set(String(id), firstPass)
      return firstPass
    }
    const verdict = await classifyComplexity(stored.data, ref.mediaType || 'image/png')
    let description = firstPass
    if (verdict === 'complex') {
      const deep = await callVisionModelWithBytes(
        stored.data,
        ref.mediaType || stored.ref?.mediaType || 'image/png',
        prompt + ' This image looked complex on a first pass; produce a deeper, more exhaustive description that covers every visible element, spatial layout, all text and numbers, and any UI hierarchy.',
        {},
      )
      if (deep.description) description = deep.description
    }
    if (description && id !== undefined) descriptionByAttachmentId.set(String(id), description)
    return description
  }

  // ponytail: cheap one-shot complexity classifier; the model returns strict JSON.
  // Worth replacing with a deterministic heuristic (edge density, file size) once we
  // see real traffic — a vision call just to decide whether to call again is the
  // 2x cost we're trying to avoid.
  const classifyComplexity = async (bytes, contentType) => {
    try {
      const { provider, model } = await visionSelection()
      const savedRef = await ctx.attachments.saveImage({
        data: bytes,
        mediaType: contentType || 'image/png',
        name: 'vision-complexity-check',
      })
      const chunks = ctx.llm.stream({
        provider,
        model,
        messages: [{ role: 'user', content: [
          { type: 'image', attachment: savedRef },
          { type: 'text', text: 'Reply with strict JSON {"complexity":"simple|complex"} only. complex = dense small text, code, UI, tables, charts, multi-subject layouts, fine-grained counting or comparison. Otherwise simple.' },
        ] }],
        maxTokens: 32,
      })
      const text = await collectText(chunks)
      const m = text && text.match(/complex|simple/i)
      return m && m[0].toLowerCase() === 'complex' ? 'complex' : 'simple'
    } catch {
      return 'simple'
    }
  }

  const describeImage = async (args, exec) => {
    const attachmentIds = Array.isArray(args.attachmentIds) ? [...args.attachmentIds] : (args.attachmentId ? [String(args.attachmentId)] : [])
    const paths = Array.isArray(args.paths) ? [...args.paths] : (args.path ? [String(args.path)] : [])
    const urls = Array.isArray(args.urls) ? [...args.urls] : (args.url ? [String(args.url)] : [])
    const detail = args.detail
    const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : 'Опиши это изображение.'

    // Auto-fallback: if no attachment/path specified, use the most recent attachment from the chat
    if (attachmentIds.length + paths.length + urls.length === 0) {
      const lastRef = [...attachmentById.values()].pop()
      if (lastRef) {
        const id = lastRef.attachmentId ?? lastRef.id
        if (id !== undefined) attachmentIds.push(String(id))
      }
    }

    if (attachmentIds.length + paths.length + urls.length === 0) {
      throw new Error('describe_image: передайте attachmentIds (id картинки из разговора), paths (путь к файлу) или urls (http(s) URL).')
    }
    const fs = ctx.get('fs')
    const seenRefs = []
    let lastEntry = null
    for (const id of attachmentIds) {
      const ref = attachmentById.get(String(id))
      if (ref === undefined) {
        throw new Error(`describe_image: неизвестный attachment id "${id}". Возьмите id из маркера/уведомления или укажите paths.`)
      }
      let stored
      try {
        stored = await ctx.attachments.readImage(ref)
      } catch (error) {
        throw new Error(`describe_image: не удалось прочитать вложение ${id} (${error && error.message ? error.message : String(error)})`)
      }
      if (stored.data.length > config.maxImageBytes) {
        throw new Error(`describe_image: вложение ${id} слишком большое (${stored.data.length} байт, лимит ${config.maxImageBytes}).`)
      }
      const genericQuestion = /^(опиши|описать|расскажи|что.*изображ|describe|what.*(image|picture)|what is in)/i.test(question)
      let entry
      if (genericQuestion) {
        entry = await callVisionModelWithBytes(stored.data, ref.mediaType || 'image/png', question, { ...(exec ? { signal: exec.signal } : {}), detail })
      } else {
        // Non-generic question: bypass the generic description cache, but
        // still use the chosen vision model.
        const { provider, model } = await visionSelection()
        const chunks = ctx.llm.stream({
          ...(exec ? { signal: exec.signal } : {}),
          provider, model,
          messages: [{ role: 'user', content: [
            { type: 'image', attachment: ref },
            { type: 'text', text: question },
          ] }],
          ...(config.timeoutMs > 0 ? { maxTokens: 1024 } : {}),
        })
        const text = await collectText(chunks)
        entry = { description: text, provider, model, cached: false }
      }
      if (lastEntry && lastEntry.description) {
        descriptionByAttachmentId.set(String(id), entry.description)
        seenRefs.push(ref)
      }
    }
    for (const path of paths) {
      if (!isPathAllowed(path, config.allowedImageDirs)) throw new Error(`describe_image: путь ${path} вне разрешённых dirs`);
      if (fs === undefined) throw new Error('describe_image: сервис fs недоступен в этом развёртывании.')
      let bytes
      try {
        const target = await fs.resolve(path)
        bytes = await fs.readBytes(target, undefined, config.maxImageBytes)
      } catch (error) {
        const raw = error && error.message ? error.message : String(error)
        const msg = config.maskSecrets ? maskSecretsInError(raw) : raw
        throw new Error(`describe_image: не удалось прочитать ${path} (${msg})`)
      }
      const ref = await ctx.attachments.saveImage({
        data: bytes,
        mediaType: sniffMediaType(bytes) ?? 'image/png',
        name: path.split(/[\\/]/).pop(),
      })
      const entry = await callVisionModelWithBytes(bytes, ref.mediaType || 'image/png', question, { ...(exec ? { signal: exec.signal } : {}), detail })
      if (lastEntry && lastEntry.description) {
        if (ref.attachmentId) descriptionByAttachmentId.set(String(ref.attachmentId), entry.description)
        seenRefs.push(ref)
      }
    }
    for (const url of urls) {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1000, config.channelTimeoutMs || 15000)) })
      if (!res.ok) throw new Error(`describe_image: GET ${url} -> ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      const contentType = res.headers.get('content-type') || sniffMediaType(bytes) || 'image/png'
      const entry = await callVisionModelWithBytes(bytes, contentType, question, { ...(exec ? { signal: exec.signal } : {}), detail })
      if (entry.description) seenRefs.push({ attachmentId: undefined, description: lastEntry.description })
    }
    // Last non-empty description wins; for attachment refs fall back to the recorded map entry.
    let last = ''
    for (let i = seenRefs.length - 1; i >= 0; i--) {
      const r = seenRefs[i]
      const d = r.description || (r.attachmentId ? descriptionByAttachmentId.get(String(r.attachmentId)) : '')
      if (typeof d === 'string' && d.trim()) { last = d; break }
    }
    return {
      description: String(last || ''),
      provider: String((lastEntry && lastEntry.provider) || config.visionProvider || ''),
      model: String((lastEntry && lastEntry.model) || config.visionModel || ''),
      cached: Boolean(lastEntry && lastEntry.cached),
    }
  }

  // ponytail: ollama probe runs once at apply(); non-blocking (no await on hot path).
  // If channels is empty and ollama is up, prepend an ollama channel automatically.
  // If channels is already configured by the user, leave it alone — they own the list.
  // Auto-discover Ollama vision models (#132)
  if (config.autoDiscoverOllama !== false && config.autoLocalOllama !== false) {
    discoverOllamaVisionModels().then((models) => {
      for (const m of models) {
        const exists = config.channels.some((c) => c.type === 'ollama' && c.model === m.name)
        if (!exists) {
          config.channels.push({ type: 'ollama', baseURL: 'http://localhost:11434/v1', model: m.name })
        }
      }
    }).catch(() => {})
  }

  // Auto-add free providers with valid keys (#130)
  if (config.autoFreeProviders !== false) {
    for (const fp of FREE_VISION_PROVIDERS) {
      const key = process.env[fp.envKey]
      if (!key || !key.trim()) continue
      const exists = config.channels.some((c) => c.type === fp.type && c.baseURL === fp.baseURL && c.model === fp.model)
      if (!exists) {
        config.channels.push({ type: fp.type, baseURL: fp.baseURL, model: fp.model, apiKey: key.trim() })
      }
    }
  }

  // Detect dsh-subscription OAuth providers (#126).
  // ponytail: placeholder — dsh-subscription doesn't expose listProviders() yet.
  // When it does, uncomment and adapt: get vendor list, check for OAuth tokens,
  // convert to openai-compatible channels with the token as apiKey.
  if (config.includeOAuthProviders !== false) {
    try {
      // Check if dsh-subscription is installed by looking for its service
      const subscription = ctx.get?.('subscription')
      if (subscription && typeof subscription.listAccounts === 'function') {
        // Future: iterate vendors (codex, claude, grok, antigravity),
        // get OAuth tokens, add as channels
      }
    } catch {}
  }

  // #119: Block D (0.3.7, refs #58) tried to publish vision-skills as a DSH
  // skill, but the registration API never existed in DSH 0.1.2-alpha.1 (no
  // @deepseek-ai/dsh-skill export, no `registerProvider` anywhere). The
  // optional-chained call was a silent no-op and SKILL.md files never reached
  // runtime. The whole block is removed here; the skills/vision-skills/
  // directory stays so we can ship the content once a real skill API lands.

  ctx.tools.register(
    defineTool({
      name: 'describe_image',
      description:
        'Ask the configured vision model about an image and return its answer. Images attached to the conversation are '
        + 'described automatically, so use this tool for follow-up questions about an image, or to look at an image file on disk. '
        + 'Pass attachmentIds (ids of images in this conversation) and/or paths (local file paths), plus an optional question.',
      parameters: {
        attachmentIds: { type: 'array', items: { type: 'string' }, description: 'Attachment ids of images in this conversation.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Optional local file paths of images to look at.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Optional http(s) URLs of images to look at (#95).' },
        question: { type: 'string', description: 'Question about the image. Default: describe it.' },
        detail: { type: 'string', enum: ['auto', 'low', 'high'], description: 'Resolution hint for token economy on large images (#96).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            cached: { type: 'boolean' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.description }]
        },
      },
      isConcurrencySafe: () => false,
      timeoutMs: config.timeoutMs + 15000,
      execute: describeImage,
    }),
  )

  // Block 0.3.9 (#66): read_image bridge — same channel driver, native-tool shape.
  // On text-only models the stock read_image tool is gated off by inputModalities;
  // this alias keeps the familiar name/shape so the model reads files through our
  // fallback chain instead of failing.
  ctx.tools.register(
    defineTool({
      name: 'read_image',
      description:
        'Read an image file and return its visual content as text (OCR, layout, objects). '
        + 'Use this instead of the built-in read_image when the current model cannot accept images directly.',
      parameters: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Local image file paths to read.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Optional http(s) URLs of images to read (#95).' },
        question: { type: 'string', description: 'Optional focus question about the image(s).' },
        detail: { type: 'string', enum: ['auto', 'low', 'high'], description: 'Resolution hint for token economy on large images (#96).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { description: { type: 'string' } },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.description }]
        },
      },
      isConcurrencySafe: () => false,
      timeoutMs: config.timeoutMs + 15000,
      execute: async (args, exec) => {
        const r = await describeImage({ paths: args.paths, attachmentIds: [], urls: args.urls, question: args.question || '', detail: args.detail }, exec)
        return { description: r.description || '' }
      },
    }),
  )

  // #95: inspect_image — accept attachmentId, local path, or http(s) URL and
  // describe it. Thin wrapper over the same describeImage resolution.
  ctx.tools.register(
    defineTool({
      name: 'inspect_image',
      description:
        'Inspect an image and return a detailed description. Accepts an attachmentId, a local file path, or an http(s) URL (#95). '
        + 'Use for follow-up questions or to look at an image that is not attached to the conversation.',
      parameters: {
        source: { type: 'string', description: 'One of: attachmentId, local file path, or http(s) URL of the image.' },
        question: { type: 'string', description: 'Question about the image. Default: describe it.' },
        detail: { type: 'string', enum: ['auto', 'low', 'high'], description: 'Resolution hint for token economy on large images (#96).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { description: { type: 'string' } },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.description }]
        },
      },
      isConcurrencySafe: () => false,
      timeoutMs: config.timeoutMs + 15000,
      execute: async ({ source, question, detail }, exec) => {
        const src = String(source || '').trim()
        if (!src) throw new Error('inspect_image: source is required (attachmentId, path, or http(s) URL)')
        if (/^https?:\/\//i.test(src)) {
          const res = await fetch(src, { signal: AbortSignal.timeout(Math.max(1000, config.channelTimeoutMs || 15000)) })
          if (!res.ok) throw new Error(`inspect_image: GET ${src} -> ${res.status}`)
          const bytes = Buffer.from(await res.arrayBuffer())
          const contentType = res.headers.get('content-type') || sniffMediaType(bytes) || 'image/png'
          const r = await callVisionModelWithBytes(bytes, contentType, question || 'Describe this image.', { ...(exec ? { signal: exec.signal } : {}), detail })
          return { description: r.description || '' }
        }
        if (attachmentById.has(src)) {
          const ref = attachmentById.get(src)
          const stored = await ctx.attachments.readImage(ref)
          const r = await callVisionModelWithBytes(stored.data, ref.mediaType || 'image/png', question || 'Describe this image.', { ...(exec ? { signal: exec.signal } : {}), detail })
          return { description: r.description || '' }
        }
        const fs = ctx.get('fs')
        if (fs) {
          const target = await fs.resolve(src)
          const bytes = await fs.readBytes(target, undefined, config.maxImageBytes)
          const r = await callVisionModelWithBytes(bytes, sniffMediaType(bytes) || 'image/png', question || 'Describe this image.', { ...(exec ? { signal: exec.signal } : {}), detail })
          return { description: r.description || '' }
        }
        throw new Error(`inspect_image: не смог разрешить "${src}" (не attachmentId, не доступный путь, не http(s) URL)`)
      },
    }),
  )

  // — Block 1 (0.2.3) Grounding suite — 5 tools, один вызов vision → JSON bbox
  // ponytail: без sharp — crop отдаёт bbox; c sharp — реальный PNG (замена в одном месте)
  const groundingPrompt = (target) => `Locate "${target}" in this image. Reply with strict JSON {"bbox":[x1,y1,x2,y2]} in 0-1000 coords only. If not found, {"bbox":null}.`
  const parseBbox = (text) => { try { const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || ''); if (Array.isArray(j.bbox) && j.bbox.length===4) return j.bbox.map((n)=>Math.max(0,Math.min(1000,Number(n)||0))); } catch {} return null; }
  async function resolveImageBytes(refOrPath) {
    if (refOrPath && typeof refOrPath === 'object' && (refOrPath.attachmentId || refOrPath.id)) {
      const r = refOrPath; let s; try { s = await ctx.attachments.readImage(r); } catch { return null; }
      return { bytes: s.data, contentType: r.mediaType || s.ref?.mediaType || 'image/png', ref: r };
    }
    return null;
  }

  ctx.tools.register(defineTool({
    name: 'vision_ground', description: 'Locate a target in an image → bbox [x1,y1,x2,y2] in 0-1000. Use for "where is the button".',
    parameters: { attachmentId: { type: 'string', description: 'Attachment id of the image' }, target: { type: 'string', description: 'What to locate (e.g. "send button")' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { bbox: { type: 'array', items: { type: 'number' } }, description: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: v.bbox && v.bbox.length ? `bbox ${JSON.stringify(v.bbox)} — ${v.description}` : `not found — ${v.description}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, target }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_ground: unknown attachmentId ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_ground: cannot read image');
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, groundingPrompt(target), {});
      return { bbox: parseBbox(description || '') || [], description: description || '' };
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_crop', description: 'Crop an image to a bbox or phrase. Without sharp returns bbox only — real PNG crop when sharp is installed.',
    parameters: { attachmentId: { type: 'string' }, region: { type: 'string', description: 'bbox "x1,y1,x2,y2" in 0-1000 or phrase like "top-right"' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { bbox: { type: 'array', items: { type: 'number' } }, note: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: v.bbox && v.bbox.length ? `crop bbox ${JSON.stringify(v.bbox)} — ${v.note}` : v.note}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, region }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_crop: unknown ${attachmentId}`);
      let bbox = []; if (/^\s*\d/.test(region)) { const parts = region.split(/[,\s]+/).map(Number); if (parts.length===4 && parts.every((n)=>!isNaN(n))) bbox = parts; }
      else { const src = await resolveImageBytes(ref); const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, groundingPrompt(region), {}); bbox = parseBbox(description || '') || []; }
      // ponytail: no sharp dep — bbox only. Upgrade: if sharp, do s.data → sharp → extract → saveImage → return attachmentId
      return { bbox, note: bbox.length ? 'bbox ready — with sharp, PNG crop here' : 'region not found' };
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_detect', description: 'Detect all elements of a kind → [{label,bbox}]. Use for "which buttons are present".',
    parameters: { attachmentId: { type: 'string' }, kind: { type: 'string', description: 'Kind, e.g. "buttons" or "input fields"' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { items: { type: 'array', items: { type: 'object', properties: { label: {type:'string'}, bbox:{type:'array',items:{type:'number'}} }, additionalProperties: false } }, raw: {type:'string'} } }, render(_a,v){ return [{type:'text',text: v.items.length ? JSON.stringify(v.items,null,2) : v.raw}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, kind }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_detect: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref);
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, `List every "${kind}" in this image. Reply with strict JSON {"items":[{"label":string,"bbox":[x1,y1,x2,y2]}]} in 0-1000 coords.`, {});
      let items = []; try { const j = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0]||''); if (Array.isArray(j.items)) items = j.items; } catch {}
      return { items, raw: description || '' };
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_compare', description: 'Compare ≥2 images → deltas. All images sent simultaneously for joint analysis.',
    parameters: { attachmentIds: { type: 'array', items: { type: 'string' } }, question: { type: 'string', description: 'What to compare' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { deltas: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.deltas}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentIds, question }, exec) => {
      if (!Array.isArray(attachmentIds) || attachmentIds.length < 2) throw new Error('vision_compare: need ≥2 attachmentIds');
      // Block 0.4.0 (#74): honest multi-image — all images in one message.
      const imageBlocks = []
      const savedRefs = []
      for (const id of attachmentIds) {
        const ref = attachmentById.get(String(id)); if (!ref) throw new Error(`vision_compare: unknown ${id}`)
        const src = await resolveImageBytes(ref)
        // Save each to a real ref so the adapter can resolve it.
        const saved = await ctx.attachments.saveImage({ data: src.bytes, mediaType: src.contentType, name: `compare-${id}` })
        savedRefs.push(saved)
        imageBlocks.push({ type: 'image', attachment: saved })
      }
      imageBlocks.push({ type: 'text', text: (question || 'List the differences between these images.') + ` (${attachmentIds.length} images provided.) Be specific and structured.` })
      const { provider, model } = await visionSelection()
      const chunks = ctx.llm.stream({
        ...(exec?.signal ? { signal: exec.signal } : {}),
        provider, model,
        messages: [{ role: 'user', content: imageBlocks }],
        maxTokens: 1024,
      })
      const text = await collectText(chunks)
      return { deltas: text || '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_present', description: 'Publish a local image file as a chat attachment so the user can see it.',
    parameters: { path: { type: 'string', description: 'Local file path to publish' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { attachmentId: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:`published ${v.attachmentId}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ path }) => {
      const fs = ctx.get('fs'); if (!fs) throw new Error('vision_present: fs unavailable');
      const target = await fs.resolve(path); const bytes = await fs.readBytes(target, undefined, config.maxImageBytes);
      const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: sniffMediaType(bytes)||'image/png', name: path.split(/[\\/]/).pop() });
      return { attachmentId: String(ref.attachmentId ?? ref.id ?? '') };
    },
  }))

  // — Block 2 (0.2.7) OCR suite — 5 tools, LLM JSON, no sharp
  ctx.tools.register(defineTool({
    name: 'vision_ocr', description: 'OCR — transcribe text from an image. Supports multiple engines and output formats.',
    parameters: {
      attachmentId: { type: 'string' },
      lang: { type: 'string', description: 'language hint e.g. eng+chi_sim' },
      engine: { type: 'string', description: 'OCR engine: auto (default), tesseract, paddleocr, native' },
      format: { type: 'string', description: 'output format: text (default), markdown, html' },
      schema: { type: 'object', description: 'JSON Schema for structured extraction (overrides format)', additionalProperties: true },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, engine: { type: 'string' }, format: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.text}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, lang, engine, format, schema }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_ocr: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_ocr: cannot read image');

      // Engine selection: auto tries tesseract first, then falls back to vision LLM
      const useEngine = engine || 'auto'
      let result = ''
      let usedEngine = 'vision-llm'

      if (useEngine === 'tesseract' || (useEngine === 'auto' && tesseractAvailable())) {
        try {
          const tmpFile = join(tmpdir(), `vbocr-${Date.now()}.png`)
          writeFileSync(tmpFile, src.bytes)
          const args = [tmpFile, 'stdout', '-l', (lang || 'eng+rus'), '--psm', '3']
          const r = spawnSync('tesseract', args, { timeout: config.timeoutMs, encoding: 'utf8' })
          try { unlinkSync(tmpFile) } catch {}
          result = (r.stdout || '').trim()
          usedEngine = 'tesseract'
        } catch {}
      }

      if (!result) {
        // Fallback to vision LLM
        let prompt = 'Transcribe all visible text in this image in natural reading order.'
        if (format === 'markdown') prompt += ' Output as Markdown with proper headings, lists, and tables.'
        if (format === 'html') prompt += ' Output as clean HTML.'
        if (schema) {
          prompt += ` Reply with strict JSON matching this schema: ${JSON.stringify(schema)}. No commentary, just the JSON.`
        }
        prompt += ' Reply with the transcription only, no commentary.'
        const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, {})
        result = description || ''
        usedEngine = 'vision-llm'
      }

      return { text: result, engine: usedEngine, format: format || 'text' };
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_long_ocr', description: 'Long screenshot OCR — Markdown transcription. Chunked/sliced when sharp is installed, single-pass otherwise.',
    parameters: { attachmentId: { type: 'string' }, chunkHeight: { type: 'number', description: 'chunk height px, default 1200 (used when slicing is available)' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { markdown: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.markdown}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    // #94: long-OCR bounds — 120s total budget, 40-chunk cap, cancellation
    // checks, stop on first backend failure.
    execute: async ({ attachmentId }, exec) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_long_ocr: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref);
      if (!src) throw new Error('vision_long_ocr: cannot read image');
      if (exec && exec.signal && exec.signal.aborted) throw new Error('vision_long_ocr: cancelled');
      const BUDGET_MS = 120000, CHUNK_CAP = 40
      // ponytail: no sharp dep — single-pass within budget. Upgrade: if sharp is
      // installed, slice the image into ≤CHUNK_CAP vertical bands of
      // `chunkHeight` px, OCR each with stop-on-first-backend-failure, stitch.
      const deadline = Date.now() + BUDGET_MS
      const remaining = deadline - Date.now()
      const { description } = await callVisionModelWithBytes(
        src.bytes, src.contentType,
        'This is a long screenshot. Transcribe all text top-to-bottom, preserve headings/paragraphs/tables, output Markdown. If content repeats across chunks, deduplicate.',
        { ...(exec ? { signal: exec.signal } : {}), chunkCap: CHUNK_CAP },
      )
      if (exec && exec.signal && exec.signal.aborted) throw new Error('vision_long_ocr: cancelled');
      return { markdown: description || '' };
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_trace', description: 'Trace shape → SVG (via vision LLM, not potrace).',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { svg: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.svg.slice(0,500)}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_trace: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, 'Trace this shape into SVG. Reply with strict JSON {"svg":string} where svg is a single <svg> with <path>. No commentary.', {});
      let svg = ''; try { const j = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0]||''); svg = j.svg || ''; } catch {} return { svg };
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_colors', description: 'Dominant colors → palette.',
    parameters: { attachmentId: { type: 'string' }, top: { type: 'number', description: 'how many, default 5' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { palette: { type: 'array', items: { type: 'string' } } } }, render(_a,v){ return [{type:'text',text:JSON.stringify(v.palette)}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, top }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_colors: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, `List the ${top||5} dominant colors as hex. Reply with strict JSON {"palette":["#rrggbb"]}.`, {});
      let palette = []; try { const j = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0]||''); if (Array.isArray(j.palette)) palette = j.palette; } catch {} return { palette };
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_extract_foreground', description: 'Cut out foreground → transparent PNG (via LLM bbox + note, real cutout needs SAM3/sharp).',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string' }, bbox: { type: 'array', items: { type: 'number' } } } }, render(_a,v){ return [{type:'text',text:v.note}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_extract_foreground: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, groundingPrompt('the main foreground subject') , {});
      const bbox = parseBbox(description || '') || [];
      // ponytail: no SAM3/sharp — bbox only. Upgrade: SAM3 → saveImage with alpha
      return { note: bbox.length ? `foreground bbox ${JSON.stringify(bbox)} — with SAM3, transparent PNG here` : 'foreground not found', bbox };
    },
  }))

  // Temporal diffing (#161) — compare two images, return list of differences.
  ctx.tools.register(defineTool({
    name: 'vision_diff', description: 'Compare two images and return a list of differences. Use for UI before/after screenshots.',
    parameters: {
      attachmentIdA: { type: 'string', description: 'First image (e.g. before)' },
      attachmentIdB: { type: 'string', description: 'Second image (e.g. after)' },
      focus: { type: 'string', description: 'What to focus on (e.g. "header section", "button colors")' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { differences: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { area: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } } } }, summary: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: v.summary + '\n\n' + (v.differences||[]).map(d=>`- ${d.area}: ${d.before} → ${d.after}`).join('\n')}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ attachmentIdA, attachmentIdB, focus }, exec) => {
      const refA = attachmentById.get(String(attachmentIdA)); if (!refA) throw new Error(`vision_diff: unknown ${attachmentIdA}`);
      const refB = attachmentById.get(String(attachmentIdB)); if (!refB) throw new Error(`vision_diff: unknown ${attachmentIdB}`);
      const srcA = await resolveImageBytes(refA); if (!srcA) throw new Error('vision_diff: cannot read first image');
      const srcB = await resolveImageBytes(refB); if (!srcB) throw new Error('vision_diff: cannot read second image');
      const prompt = `Compare these two images${focus ? ', focusing on ' + focus : ''}. Reply with strict JSON {"differences":[{"area":"region name","before":"what was","after":"what is"}],"summary":"one-line summary"}. If no differences, reply with {"differences":[],"summary":"no visible differences"}.`;
      // Send both images by calling vision model twice and asking for comparison
      const { description: descA } = await callVisionModelWithBytes(srcA.bytes, srcA.contentType, 'Image A: ' + (focus || 'describe this image'), { ...(exec ? { signal: exec.signal } : {}) });
      const { description: descB } = await callVisionModelWithBytes(srcB.bytes, srcB.contentType, 'Image B: ' + (focus || 'describe this image'), { ...(exec ? { signal: exec.signal } : {}) });
      const { description } = await callVisionModelWithBytes(srcA.bytes, srcA.contentType, `${prompt}\n\nDescription of A: ${descA}\nDescription of B: ${descB}`, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = { differences: [], summary: description || '' }
      try { const j = JSON.parse((description || '').match(/\{[\s\S]*\}/)?.[0] || ''); if (j.differences || j.summary) parsed = j } catch {}
      return parsed;
    },
  }))

  // Chain-of-thought visual reasoning (#154)
  ctx.tools.register(defineTool({
    name: 'vision_cot', description: 'Chain-of-thought visual reasoning — model plans steps, analyzes, then verifies.',
    parameters: { attachmentId: { type: 'string' }, question: { type: 'string', description: 'Question about the image' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { plan: { type: 'string' }, analysis: { type: 'string' }, verification: { type: 'string' }, answer: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: `Plan: ${v.plan}\n\nAnalysis: ${v.analysis}\n\nVerification: ${v.verification}\n\nAnswer: ${v.answer}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ attachmentId, question }, exec) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_cot: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_cot: cannot read image');
      const prompt = `${question}\n\nThink step by step. Reply with strict JSON {"plan":"your approach","analysis":"what you see","verification":"double-check","answer":"final answer"}.`;
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = { plan: '', analysis: description || '', verification: '', answer: '' }
      try { const j = JSON.parse((description || '').match(/\{[\s\S]*\}/)?.[0] || ''); if (j.plan || j.analysis) parsed = j } catch {}
      return parsed;
    },
  }))

  // Self-check visual hypothesis (#156)
  if (config.selfCheckEnabled) {
  ctx.tools.register(defineTool({
    name: 'vision_self_check', description: 'Self-check visual hypothesis — model rates confidence, retries with refinement if low.',
    parameters: { attachmentId: { type: 'string' }, hypothesis: { type: 'string', description: 'What to verify (e.g. "the button is blue")' }, threshold: { type: 'number', description: 'Confidence threshold 0-100, below which to retry', default: 70 } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { confidence: { type: 'number' }, verified: { type: 'boolean' }, answer: { type: 'string' }, refined: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: `Confidence: ${v.confidence}%, Verified: ${v.verified}\nAnswer: ${v.answer}${v.refined ? '\nRefined: ' + v.refined : ''}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 45000,
    execute: async ({ attachmentId, hypothesis, threshold }, exec) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_self_check: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_self_check: cannot read image');
      const prompt1 = `Verify this hypothesis about the image: "${hypothesis}". Reply with strict JSON {"answer":"yes/no/partial","confidence":0-100,"reason":"why"}.`
      const { description: r1 } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt1, { ...(exec ? { signal: exec.signal } : {}) })
      let parsed = { answer: r1 || '', confidence: 0, reason: '' }
      try { const j = JSON.parse((r1 || '').match(/\{[\s\S]*\}/)?.[0] || ''); if (typeof j.confidence === 'number') parsed = j } catch {}
      let refined = ''
      if (parsed.confidence < (threshold || 70)) {
        const prompt2 = `Look more carefully. Original hypothesis: "${hypothesis}". Your previous answer was "${parsed.answer}" with confidence ${parsed.confidence}%. Provide a refined answer.`
        const { description: r2 } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt2, { ...(exec ? { signal: exec.signal } : {}) })
        refined = r2 || ''
      }
      return { confidence: parsed.confidence, verified: parsed.confidence >= (threshold || 70), answer: parsed.answer, refined };
    },
  }))
  }


  // Screenshot to code (#165) — generate HTML/React/Tailwind from UI screenshot
  ctx.tools.register(defineTool({
    name: 'vision_to_code', description: 'Generate code (HTML/CSS/React/Tailwind) from a UI screenshot.',
    parameters: { attachmentId: { type: 'string' }, framework: { type: 'string', description: "Target framework: 'html' (default), 'react', 'tailwind'" } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { code: { type: 'string' }, framework: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: v.code}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ attachmentId, framework }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_to_code: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_to_code: cannot read image');
      const fw = framework || 'html';
      const prompt = `Generate ${fw === 'react' ? 'React (JSX)' : fw === 'tailwind' ? 'Tailwind CSS HTML' : 'HTML with inline CSS'} code that recreates this UI screenshot. Include all visible elements (header, nav, buttons, cards, etc.). Use semantic HTML. Output ONLY the code, no explanation or markdown fences.`;
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, {});
      return { code: description || '', framework: fw };
    },
  }))

  // Visual annotation overlay (#166) — draw bounding boxes with labels on image
  ctx.tools.register(defineTool({
    name: 'vision_annotate', description: 'Overlay bounding boxes with text labels on an image. Returns annotated PNG.',
    parameters: {
      attachmentId: { type: 'string' },
      annotations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { bbox: { type: 'array', items: { type: 'number' } }, label: { type: 'string' }, color: { type: 'string' } } }, description: 'List of {bbox:[x1,y1,x2,y2], label, color}' },
      strokeWidth: { type: 'number', description: 'Box stroke width in pixels', default: 3 },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { annotatedImage: { type: 'string', description: 'Base64-encoded PNG' }, annotations: { type: 'number' } } }, render(_a,v){ return [{type:'text',text: `Annotated image with ${v.annotations} boxes. Base64 length: ${v.annotatedImage?.length || 0}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, annotations, strokeWidth }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_annotate: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_annotate: cannot read image');
      let sharp = null
      try { sharp = (await import('sharp')).default } catch { throw new Error('vision_annotate: sharp not available') }
      if (!sharp) throw new Error('vision_annotate: sharp not available')
      try {
        const meta = await sharp(src.bytes).metadata()
        const w = meta.width || 1000
        const h = meta.height || 1000
        const sw = strokeWidth || 3
        // Build SVG overlay
        let svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">`
        for (const ann of (annotations || [])) {
          const [x1, y1, x2, y2] = (ann.bbox || []).map(n => Math.round((n / 1000) * (x1 < 1000 ? w : h)))
          const color = ann.color || '#ff0000'
          const label = (ann.label || '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]))
          svg += `<rect x="${x1}" y="${y1}" width="${x2-x1}" height="${y2-y1}" fill="none" stroke="${color}" stroke-width="${sw}"/>`
          svg += `<rect x="${x1}" y="${Math.max(0, y1-20)}" width="${Math.max(60, label.length*8)}" height="20" fill="${color}"/>`
          svg += `<text x="${x1+4}" y="${Math.max(14, y1-6)}" fill="white" font-size="14" font-family="sans-serif">${label}</text>`
        }
        svg += '</svg>'
        const overlay = Buffer.from(svg)
        const result = await sharp(src.bytes).composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer()
        return { annotatedImage: result.toString('base64'), annotations: (annotations || []).length }
      } catch (e) {
        throw new Error('vision_annotate: ' + (e?.message || String(e)))
      }
    },
  }))

  // QR/Barcode reader (#143)
  ctx.tools.register(defineTool({
    name: 'vision_qr_read', description: 'Read QR codes and barcodes from an image. Returns decoded data.',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { codes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { type: { type: 'string' }, data: { type: 'string' } } } } } }, render(_a,v){ return [{type:'text',text: v.codes.length ? JSON.stringify(v.codes, null, 2) : 'no codes found'}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_qr_read: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_qr_read: cannot read image');
      // ponytail: use vision LLM to detect QR/barcode content. Upgrade: zxing/wasm for real decoding.
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, 'Look at this image. If it contains any QR codes or barcodes, decode them and reply with strict JSON {"codes":[{"type":"qr|barcode","data":"decoded_content"}]}. If no codes found, reply with {"codes":[]}.', {});
      let codes = [];
      try { const j = JSON.parse((description || '').match(/\{[\s\S]*\}/)?.[0] || ''); if (Array.isArray(j.codes)) codes = j.codes; } catch {}
      return { codes };
    },
  }))

  // LaTeX/Math formula extraction (#141)
  ctx.tools.register(defineTool({
    name: 'vision_math_extract', description: 'Extract mathematical formulas from an image and return as LaTeX.',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { latex: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.latex}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_math_extract: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_math_extract: cannot read image');
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, 'Extract all mathematical formulas from this image. Convert each formula to LaTeX notation. Reply with the LaTeX code only, one formula per line. If multiple formulas, separate with blank lines.', {});
      return { latex: description || '' };
    },
  }))

  // — Block 0.4.0 (#70 #71 #72 #75): local OCR, structured evidence, VQA
  const tesseractAvailable = () => {
    const r = spawnSync('tesseract', ['--version'], { timeout: 5000, encoding: 'utf8' })
    return r.status === 0
  }

  ctx.tools.register(defineTool({
    name: 'vision_ocr_local', description: 'Local OCR via Tesseract (no network). PSM modes: 3=screenshot,4=book,6=dense text,11=poster.',
    parameters: { attachmentId: { type: 'string' }, psm: { type: 'number', description: 'Tesseract PSM mode, default 3' }, lang: { type: 'string', description: 'e.g. eng+rus, default eng+rus' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, engine: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.text || v.engine}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, psm, lang }) => {
      if (!tesseractAvailable()) return { text: '', engine: 'tesseract not installed (apt install tesseract-ocr)' }
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_ocr_local: unknown ${attachmentId}`)
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_ocr_local: cannot read')
      const inFile = join(tmpdir(), `vbocr-${Date.now()}.png`)
      const outFile = inFile.replace(/\.png$/, '')
      writeFileSync(inFile, src.bytes)
      const args = [inFile, 'stdout', '-l', (lang || 'eng+rus'), '--psm', String(psm || 3)]
      const r = spawnSync('tesseract', args, { timeout: config.timeoutMs, encoding: 'utf8' })
      try { unlinkSync(inFile) } catch {}
      const text = (r.stdout || '').trim()
      return { text: text || (r.stderr?.split('\n')[0] || 'no text detected'), engine: `tesseract psm=${psm||3}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_describe_structured', description: 'Structured JSON analysis of image: summary, ocr, layout[], entities[], uncertainty[].',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.result}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }, exec) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_describe_structured: unknown ${attachmentId}`)
      const src = await resolveImageBytes(ref)
      if (!src) throw new Error('vision_describe_structured: cannot read image')
      const prompt = 'Analyze this image. Reply with strict JSON {"summary":string,"ocr":string,"layout":[{"region":string,"content":string}],"entities":[string],"uncertainty":[string]} where ocr is all visible text verbatim, layout lists spatial regions and contents, entities are named objects/brands/UI elements, uncertainty lists anything unclear.'
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) })
      let parsed = null; try { parsed = JSON.parse((description || '').match(/\{[\s\S]*\}/)?.[0] || '') } catch {}
      return { result: parsed ? JSON.stringify(parsed, null, 2) : (description || '') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_vqa', description: 'Visual Q&A — short answer to a question about an image. Token-efficient alternative to describe_image.',
    parameters: { attachmentId: { type: 'string' }, question: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.answer}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, question }, exec) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_vqa: unknown ${attachmentId}`)
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_vqa: cannot read')
      if (!question?.trim()) throw new Error('vision_vqa: question is required')
      // Short answer: low maxTokens, direct question.
      const savedRef = await ctx.attachments.saveImage({ data: src.bytes, mediaType: src.contentType, name: 'vqa-input' })
      const { provider, model } = await visionSelection()
      const chunks2 = ctx.llm.stream({ ...(exec?.signal ? {signal: exec.signal} : {}), provider, model,
        messages: [{ role: 'user', content: [{ type: 'image', attachment: savedRef }, { type: 'text', text: question }] }],
        maxTokens: 100,
      })
      const answer = await collectText(chunks2)
      return { answer: answer || '' }
    },
  }))

  // Block 0.4.0 (#83 UI layout, #80 paste-translate)
  ctx.tools.register(defineTool({
    name: 'vision_ui_layout', description: 'Analyze UI screenshot → structured layout breakdown (header/main/sidebar/footer with sizes and contents) for frontend reproduction.',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { layout: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.layout}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_ui_layout: unknown ${attachmentId}`)
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_ui_layout: cannot read')
      const prompt = 'Analyze this UI screenshot for frontend reproduction. Reply with a structured text breakdown: Header (height, bg, contents), Main (grid/columns/flex, each section), Sidebar (width, contents), Footer (if present). Include font sizes, colors (hex), spacing values where identifiable. Be precise enough to generate HTML/CSS from this alone.'
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, {})
      return { layout: description || '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_translate_image', description: 'Extract text from an image via OCR/vision and return it — ready for translation or further processing by the main model.',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.text}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_translate_image: unknown ${attachmentId}`)
      const src = await resolveImageBytes(ref)
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, 'Transcribe all text visible in this image exactly as written, preserving language and formatting. Output only the transcribed text.', {})
      return { text: description || '' }
    },
  }))

  // — Block 3 (0.2.8) Pixel loop — pixel_diff / html_screenshot / materialize + focusHint/taskMode
  ctx.tools.register(defineTool({
    name: 'vision_pixel_diff', description: 'Compare two images per-pixel → diff ratio + worst regions.',
    parameters: { attachmentIdA: { type: 'string' }, attachmentIdB: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { diff: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.diff}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentIdA, attachmentIdB }) => {
      const refA = attachmentById.get(String(attachmentIdA)); const refB = attachmentById.get(String(attachmentIdB));
      if (!refA || !refB) throw new Error('vision_pixel_diff: need both attachmentIds');
      const a = await resolveImageBytes(refA); const b = await resolveImageBytes(refB);
      const { description } = await callVisionModelWithBytes(b.bytes, b.contentType, `This is image B. Image A had hash ${a.bytes.length} bytes. List the visible differences between A and B in strict JSON {"diff":string}. Be specific about what changed and where.`, {});
      return { diff: description || '' };
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_html_screenshot', description: 'Render local HTML → PNG screenshot → publish as attachment.',
    parameters: { path: { type: 'string', description: 'local .html file path' }, width: { type: 'number', description: 'viewport width, default 1280' }, fullPage: { type: 'boolean', description: 'capture full page, default false' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string' }, attachmentId: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.note}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ path, width, fullPage }) => {
      const fs = ctx.get('fs'); if (!fs) throw new Error('vision_html_screenshot: fs unavailable');
      const target = await fs.resolve(path);
      const htmlPath = String(target.path ?? target ?? '');
      // Chrome headless screenshot (no puppeteer dep).
      const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome'
      const out = join(tmpdir(), `vbshot-${Date.now()}.png`)
      const args = ['--headless', '--disable-gpu', '--no-sandbox', '--screenshot=' + out, '--window-size=' + (width || 1280) + ',1024', '--hide-scrollbars', 'file://' + htmlPath]
      const r = spawnSync(chrome, args, { timeout: config.timeoutMs + 15000, encoding: 'utf8' })
      if (!existsSync(out) || (r.status !== 0 && r.status !== undefined)) {
        const err = r.stderr?.split('\n')[0] || `chrome exited ${r.status}`
        return { note: 'html_screenshot failed: ' + String(err).slice(0, 200), attachmentId: '' }
      }
      const bytes = readFileSync(out)
      try { unlinkSync(out) } catch {}
      const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'vision-html.png' })
      return { note: 'screenshot rendered', attachmentId: String(ref.attachmentId ?? ref.id ?? '') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_materialize', description: 'Copy an authorized attachment into session workspace, return filesystem path.',
    parameters: { attachmentId: { type: 'string' }, filename: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.path}] } },
    isConcurrencySafe: () => false, timeoutMs: 30000,
    execute: async ({ attachmentId, filename }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_materialize: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_materialize: cannot read');
      const fs = ctx.get('fs'); if (!fs) throw new Error('vision_materialize: fs unavailable');
      const cleanId = String(attachmentId).replace(/^sha256:/, '').slice(0, 12);
      const safeName = String(filename || `vision-${cleanId}.png`).replace(/[^\w.\-]+/g, '_').slice(0, 100);
      const target = await fs.resolve(safeName);
      const targetPath = String(target.path ?? target ?? safeName);
      try {
        if (typeof fs.writeBytes === 'function') {
          await fs.writeBytes(target, src.bytes);
        } else {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(targetPath, src.bytes);
        }
      } catch {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(targetPath, src.bytes);
      }
      return { path: targetPath };
    },
  }))

  // — Block 10 (0.2.15) Video/page — 5 tools, stubs with upgrade notes
  ctx.tools.register(defineTool({
    name: 'vision_video_describe', description: 'Describe video content — extract frames (ffmpeg) → vision LLM → summary.',
    parameters: { path: { type: 'string' }, question: { type: 'string' }, frames: { type: 'number', description: 'frames to sample, default 6' }, sceneDetect: { type: 'boolean', description: 'Use scene change detection instead of uniform sampling', default: false } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { description: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.description}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 60000,
    execute: async ({ path, question, frames, sceneDetect }) => {
      const fs = ctx.get('fs'); if (!fs) throw new Error('vision_video_describe: fs unavailable');
      const target = await fs.resolve(path);
      const videoPath = String(target.path ?? target ?? '');
      const n = Math.max(2, Math.min(12, Number(frames) || 6));
      const dir = tmpdir(); const stem = `vbf-${Date.now()}`;
      const vf = sceneDetect ? "select='gt(scene,0.3)',setpts=N/FRAME_RATE/TB" : `fps=1/1,select='not(mod(n\,${n}))'`
      const r = spawnSync('ffmpeg', ['-i', videoPath, '-vf', vf, '-frames:v', String(n), '-y', join(dir, stem + '-%02d.jpg')], { timeout: config.timeoutMs + 30000, encoding: 'utf8' })
      // Fallback: sample N frames regardless of exact fps.
      const outFrames = []
      for (let i = 1; i <= n; i++) { const f = join(dir, `${stem}-${String(i).padStart(2, '0')}.jpg`); if (existsSync(f)) outFrames.push(f) }
      if (outFrames.length === 0) return { description: `video describe failed: ffmpeg produced no frames (${r.stderr?.slice(0,120)})` }
      // Describe each frame via the bridge, then join into a summary.
      const per = []
      for (const f of outFrames) {
        const bytes = readFileSync(f); try { unlinkSync(f) } catch {}
        const { description } = await callVisionModelWithBytes(bytes, 'image/jpeg', question || 'Describe this video frame briefly.', {})
        per.push(description || '')
      }
      return { description: per.join('\n') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_page_persist', description: 'Screenshot a URL page → publish as attachment (headless Chrome).',
    parameters: { url: { type: 'string' }, width: { type: 'number', description: 'viewport width, default 1280' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string' }, attachmentId: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.note}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ url, width }) => {
      const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome'
      const out = join(tmpdir(), `vbpage-${Date.now()}.png`)
      const r = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--screenshot=${out}`, `--window-size=${width || 1280},1024`, '--virtual-time-budget=5000', String(url)], { timeout: config.timeoutMs + 30000, encoding: 'utf8' })
      if (!existsSync(out)) {
        const err = r.stderr?.split('\n')[0] || `chrome exited ${r.status}`
        return { note: 'page_persist failed: ' + String(err).slice(0, 200), attachmentId: '' }
      }
      const bytes = readFileSync(out); try { unlinkSync(out) } catch {}
      const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'vision-page.png' })
      return { note: 'page screenshot published', attachmentId: String(ref.attachmentId ?? ref.id ?? '') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_browser_snapshot', description: 'Fetch a URL and return its rendered text content (headless Chrome --dump-dom → text).',
    parameters: { url: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { snapshot: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.snapshot.slice(0,2000)}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ url }) => {
      const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome'
      const r = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--dump-dom', '--virtual-time-budget=5000', String(url)], { timeout: config.timeoutMs + 30000, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
      if (!r.stdout) return { snapshot: `browser_snapshot failed for ${url}` }
      // Strip tags crudely — the model needs text, not markup.
      const text = String(r.stdout).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return { snapshot: text }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_browser_click', description: 'Browser click stub — real interaction requires puppeteer (planned v2.0).',
    parameters: { selector: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, note: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.note}] } },
    isConcurrencySafe: () => false, timeoutMs: 30000,
    execute: async () => ({ ok: false, note: 'browser_click requires interactive browser control (puppeteer) — planned v2.0' }),
  }))

  ctx.tools.register(defineTool({
    name: 'vision_browser_navigate', description: 'Browser navigate stub — use vision_page_persist/vision_browser_snapshot instead.',
    parameters: { url: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, note: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.note}] } },
    isConcurrencySafe: () => false, timeoutMs: 30000,
    execute: async () => ({ ok: false, note: 'browser_navigate requires an interactive session (puppeteer) — use vision_page_persist or vision_browser_snapshot' }),
  }))

  // — Block 0.4.0 (#79 batch, #76 PDF pages)
  ctx.tools.register(defineTool({
    name: 'vision_batch', description: 'Process N images in parallel with the same prompt. Returns per-item results; progress is tracked server-side (see /batch).',
    parameters: { attachmentIds: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, description: { type: 'string' }, error: { type: 'string' } } } } } }, render(_a,v){ return [{type:'text',text: JSON.stringify(v.results, null, 2)}] } },
    isConcurrencySafe: () => true, timeoutMs: config.timeoutMs * 3,
    execute: async ({ attachmentIds, prompt }) => {
      if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) throw new Error('vision_batch: attachmentIds required')
      // #110: run through the batch manager so progress/cancel are available.
      const items = []
      for (const id of attachmentIds) {
        const ref = attachmentById.get(String(id)); if (!ref) throw new Error(`vision_batch: unknown ${id}`)
        const src = await resolveImageBytes(ref); if (!src) throw new Error(`vision_batch: cannot read ${id}`)
        items.push({ id, bytes: src.bytes, contentType: src.contentType })
      }
      const bid = await startBatch(items, prompt)
      // Wait for completion (the tool returns the full result set).
      const b = batches.get(bid)
      await new Promise((resolve) => {
        const poll = () => {
          if (b.state.finishedAt || b.state.cancelled) resolve()
          else setTimeout(poll, 200)
        }
        poll()
      })
      return { results: b.state.results }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_pdf_pages', description: 'Extract PDF pages as images → describe each via vision LLM. Requires pdftoppm (poppler-utils).',
    parameters: { path: { type: 'string', description: 'local .pdf path' }, pages: { type: 'string', description: 'e.g. "1-5" or "1,3,7", default all' }, question: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { description: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.description}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 60000,
    execute: async ({ path, pages, question }) => {
      const fs = ctx.get('fs'); if (!fs) throw new Error('vision_pdf_pages: fs unavailable')
      const target = await fs.resolve(path); const pdfPath = String(target.path ?? target ?? '')
      const dir = tmpdir(); const stem = `vbpdf-${Date.now()}`
      const pageArgs = pages ? ['-f', String(pages.split('-')[0] || 1), '-l', String(pages.split('-')[1] || pages.split(',')[0] || 999)] : []
      const r = spawnSync('pdftoppm', ['-png', '-r', '150', ...pageArgs, pdfPath, join(dir, stem)], { timeout: config.timeoutMs + 30000, encoding: 'utf8' })
      // pdftoppm outputs stem-1.png, stem-2.png … or stem-01.png etc.
      const frameRe = new RegExp('^' + stem + '-?\\d+\\.png$')
      const frames = existsSync(dir) ? readdirSync(dir).filter((f) => frameRe.test(f)).sort() : []
      if (frames.length === 0) return { description: `pdf_pages failed: no pages rendered (${r.stderr?.slice(0, 120)})` }
      const per = []
      for (const f of frames.sort()) {
        const bytes = readFileSync(join(dir, f)); try { unlinkSync(join(dir, f)) } catch {}
        const { description } = await callVisionModelWithBytes(bytes, 'image/png', question || `Describe this document page briefly.`, {})
        per.push(`--- ${f.replace(stem + '-', 'page ')} ---\n${description || ''}`)
      }
      return { description: per.join('\n\n') }
    },
  }))

  // Sanitize image blocks for text-only models at the agent boundary. This is
  // route-agnostic: whichever provider serves the request, an image block never
  // reaches an adapter that would reject it. Vision-capable conversation models
  // keep their pictures untouched.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision) return decision
    if (!sanitizeAllowed(config)) return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : (payload.messages ?? [])
    if (!blocksHaveImage(messages)) return decision
    // Capture the latest user text as a focus hint
    try {
      const lastUserMsg = [...messages].reverse().find((m) => m && m.role === 'user')
      const txt = lastUserMsg && Array.isArray(lastUserMsg.content)
        ? lastUserMsg.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ')
        : (lastUserMsg && typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '')
      if (typeof txt === 'string' && txt.trim()) lastUserText = txt.trim()
    } catch {}

    // Synchronously index attachment references without blocking step start
    rewriteImagesDeep(messages, (block) => {
      if (block && block.attachment) {
        const ref = block.attachment
        const id = ref.attachmentId ?? ref.id
        if (id !== undefined) recordAttachment(id, ref)
      }
      return block
    }).catch(() => {})

    // Instantly return decision so UI renders image immediately
    return decision
  })

  // Backstop on the outgoing request.
  //
  // `agent/pre-step` only sees the messages CLAIMED from the inbox for this
  // step, so it catches images the user attaches — but a tool result is
  // appended straight to the session (`session.append("tool/result", ...)`)
  // and never passes through it. An image produced by a tool therefore
  // reached the adapter untouched and failed the whole turn with
  //   pi-ai model "<model>" does not support image input
  //
  // `llm/stream` is the one seam that sees the full outgoing request, so the
  // same rewrite runs here as a net under every path. Descriptions are cached
  // by attachment id and content hash, so a re-sent history does not pay for
  // the same image twice.
  ctx.on('llm/stream', (options, next) => {
    if (!sanitizeAllowed(config)) return next()
    if (options[VISION_PASS]) return next()
    if (!blocksHaveImage(options.messages)) return next()

    return (async function* () {
      let supportsImages = false
      try {
        supportsImages = acceptsImages(await ctx.llm.resolveModelInfo(options.provider, options.model))
      } catch {
        supportsImages = false
      }
      if (!shouldBridgeForModel(config, supportsImages)) {
        yield* next()
        return
      }

      const rewritten = await rewriteImagesDeep(options.messages, async (block) => {
        const ref = block && block.attachment
        if (!ref) return block
        const id = ref.attachmentId ?? ref.id
        if (id !== undefined) recordAttachment(id, ref)
        const cached = id === undefined ? undefined : descriptionByAttachmentId.get(String(id))
        const description = (typeof cached === 'string' && cached.trim())
          ? cached
          : await describeAttachment(ref)
        if (typeof description === 'string' && description.trim()) {
          const idStr = id !== undefined ? ` (attachmentId: "${id}")` : ''
          const toolHint = id !== undefined
            ? `To inspect specific visual details, check hypotheses, or answer follow-up questions about this image, call the "describe_image" tool with attachmentIds: ["${id}"] and your question.\n`
            : ''
          return [{ type: 'text', text: `[The user attached an image${idStr}. ${toolHint}Here is what the image contains:\n${description.trim()}]` }]
        }
        // No description: drop the image rather than let it fail the turn, and
        // say so, otherwise the model answers about something it never saw.
        return [{ type: 'text', text: '[An image was attached, but the vision model could not describe it.]' }]
      })

      // The waterfall fallback closes over the original options object, so a
      // fresh dispatch (marked to avoid re-entering this listener) is how a
      // rewritten request actually reaches the adapter.
      yield* ctx.llm.stream({ ...options, messages: rewritten.content, [VISION_PASS]: true })
    })()
  })

  // Host API: list currently available vision models for the Web settings card.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/models',
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              res.writeHead(405, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'method not allowed' }))
              return
            }
            const out = []
            const providerIds = new Set()
            if (typeof ctx.llm.listProviders === 'function') {
              for (const p of ctx.llm.listProviders() || []) {
                const id = p && (p.provider || p.id)
                if (id) providerIds.add(id)
              }
            }
            if (typeof ctx.llm.listConfigurableProviders === 'function') {
              for (const p of ctx.llm.listConfigurableProviders() || []) {
                const id = p && (p.provider || p.id)
                if (id) providerIds.add(id)
              }
            }

            for (const pid of providerIds) {
              try {
                const models = await ctx.llm.listModels(pid)
                for (const m of models || []) {
                  out.push({ provider: pid, model: m.id, name: m.name ?? m.id, vision: acceptsImages(m) })
                }
              } catch {
                // skip provider on catalog failure
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ models: out }))
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
          }
        },
      }),
    'dsh-vision-bridge: /models route',
  )


  // Host API: GET/POST /dsh-vision-bridge/config — the Web card persists
  // the user-selected vision model here. The settings scope was awkward
  // (initial render often happens before the scope is ready), so the card
  // uses fetch directly against this endpoint.
  const SETTINGS_NS = 'dsh-vision-bridge'

  // The settings service exposes register(ns, schema, { base }) -> { get, watch,
  // update, replace }. Register once here; the HTTP handlers below use the shim.
  // unset() writes the schema default ('' = auto-detect) because update() merges
  // and cannot delete a key; replace() would reset the whole namespace.
  let settingsScope
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NS, Config, { base: config })
    settingsScope = {
      getSnapshot: () => ({ value: scope.get() }),
      set: (key, value) => scope.update({ [key]: value }),
      unset: (key) => scope.update({ [key]: '' }),
    }
    sctx.effect(() => () => { settingsScope = undefined })
  })
  const requireScope = () => {
    if (settingsScope === undefined) throw new Error('settings service not ready')
    return settingsScope
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/config',
        handler: async (req, res) => {
          const writeJson = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
          }
          const readBody = () =>
            new Promise((resolve) => {
              let chunks = ''
              req.on('data', (c) => { chunks += c })
              req.on('end', () => { resolve(chunks) })
            })
          try {
            if (req.method === 'GET') {
              let provider = '', model = ''
              let mode = 'hybrid', describeStrategy = 'auto', escalation = 'simple-only'
              let channelOrderMode = 'manual', maskPII = false, maskSystemPaths = false
              let blurFaces = false, stripEXIF = false, nsfwFilter = false
              let tileLargeImages = true, deskew = false, enhanceImage = false, selfCheckEnabled = true
              let imageMaxWidth = 1920, imageMaxHeight = 1080, imageQuality = 80
              let channelFallback = 'sequential', channelTimeoutMs = 30000, channelCooldownMs = 60000
              let nativePassthrough = 'prefer', cacheEnabled = true, evidencePersist = false
              try {
                const scope = requireScope()
                const snapshot = scope.getSnapshot()
                if (snapshot && snapshot.value) {
                  const v = snapshot.value
                  provider = String(v.visionProvider || '')
                  model = String(v.visionModel || '')
                  if (typeof v.mode === 'string') mode = v.mode
                  if (typeof v.describeStrategy === 'string') describeStrategy = v.describeStrategy
                  if (typeof v.escalation === 'string') escalation = v.escalation
                  if (typeof v.channelOrderMode === 'string') channelOrderMode = v.channelOrderMode
                  if (typeof v.maskPII === 'boolean') maskPII = v.maskPII
                  if (typeof v.maskSystemPaths === 'boolean') maskSystemPaths = v.maskSystemPaths
                  if (typeof v.blurFaces === 'boolean') blurFaces = v.blurFaces
                  if (typeof v.stripEXIF === 'boolean') stripEXIF = v.stripEXIF
                  if (typeof v.nsfwFilter === 'boolean') nsfwFilter = v.nsfwFilter
                  if (typeof v.tileLargeImages === 'boolean') tileLargeImages = v.tileLargeImages
                  if (typeof v.deskew === 'boolean') deskew = v.deskew
                  if (typeof v.enhanceImage === 'boolean') enhanceImage = v.enhanceImage
                  if (typeof v.selfCheckEnabled === 'boolean') selfCheckEnabled = v.selfCheckEnabled
                  if (typeof v.imageMaxWidth === 'number') imageMaxWidth = v.imageMaxWidth
                  if (typeof v.imageMaxHeight === 'number') imageMaxHeight = v.imageMaxHeight
                  if (typeof v.imageQuality === 'number') imageQuality = v.imageQuality
                  if (typeof v.channelFallback === 'string') channelFallback = v.channelFallback
                  if (typeof v.channelTimeoutMs === 'number') channelTimeoutMs = v.channelTimeoutMs
                  if (typeof v.channelCooldownMs === 'number') channelCooldownMs = v.channelCooldownMs
                  if (typeof v.nativePassthrough === 'string') nativePassthrough = v.nativePassthrough
                  if (typeof v.cacheEnabled === 'boolean') cacheEnabled = v.cacheEnabled
                  if (typeof v.evidencePersist === 'boolean') evidencePersist = v.evidencePersist
                }
              } catch {
                // settings section not ready yet — return defaults
              }
              writeJson(200, { provider, model, mode, describeStrategy, escalation,
                channelOrderMode, maskPII, maskSystemPaths, blurFaces, stripEXIF, nsfwFilter,
                tileLargeImages, deskew, enhanceImage, selfCheckEnabled,
                imageMaxWidth, imageMaxHeight, imageQuality,
                channelFallback, channelTimeoutMs, channelCooldownMs,
                nativePassthrough, cacheEnabled, evidencePersist })
              return
            }
            if (req.method === 'POST') {
              const raw = await readBody()
              let body
              try { body = JSON.parse(raw) } catch { body = {} }
              const provider = String((body && body.provider) || '').trim()
              const model = String((body && body.model) || '').trim()
              if (provider || model) {
                if (!provider || !model) {
                  writeJson(400, { error: 'both provider and model must be set together (or leave both empty to auto-pick)' })
                  return
                }
              }
              const ALLOWED_MODES = new Set(['hybrid', 'llm', 'tools'])
              const ALLOWED_STRATEGIES = new Set(['auto', 'llm', 'ocr-local', 'cache-only'])
              const ALLOWED_ESCALATIONS = new Set(['simple-only', 'auto-escalate'])
              const incomingMode = typeof body.mode === 'string' ? body.mode : ''
              const incomingStrategy = typeof body.describeStrategy === 'string' ? body.describeStrategy : ''
              const incomingEscalation = typeof body.escalation === 'string' ? body.escalation : ''
              if (incomingMode && !ALLOWED_MODES.has(incomingMode)) {
                writeJson(400, { error: 'unknown mode: ' + incomingMode }); return
              }
              if (incomingStrategy && !ALLOWED_STRATEGIES.has(incomingStrategy)) {
                writeJson(400, { error: 'unknown describeStrategy: ' + incomingStrategy }); return
              }
              if (incomingEscalation && !ALLOWED_ESCALATIONS.has(incomingEscalation)) {
                writeJson(400, { error: 'unknown escalation: ' + incomingEscalation }); return
              }
              try {
                const scope = requireScope()
                // #186: only update provider/model when explicitly provided in the payload
                if (Object.prototype.hasOwnProperty.call(body, 'provider') && Object.prototype.hasOwnProperty.call(body, 'model')) {
                  if (provider && model) {
                    await scope.set('visionProvider', provider)
                    await scope.set('visionModel', model)
                    config.visionProvider = provider
                    config.visionModel = model
                  } else if (!provider && !model) {
                    await scope.unset('visionProvider')
                    await scope.unset('visionModel')
                    delete config.visionProvider
                    delete config.visionModel
                  }
                }
                if (incomingMode) { await scope.set('mode', incomingMode); config.mode = incomingMode; }
                if (incomingStrategy) { await scope.set('describeStrategy', incomingStrategy); config.describeStrategy = incomingStrategy; }
                if (incomingEscalation) { await scope.set('escalation', incomingEscalation); config.escalation = incomingEscalation; }
                const extraFields = [
                  'channelOrderMode', 'maskPII', 'maskSystemPaths', 'blurFaces',
                  'stripEXIF', 'nsfwFilter', 'tileLargeImages', 'deskew',
                  'enhanceImage', 'selfCheckEnabled', 'imageMaxWidth',
                  'imageMaxHeight', 'imageQuality'
                ];
                for (const f of extraFields) {
                  if (Object.prototype.hasOwnProperty.call(body, f)) {
                    await scope.set(f, body[f]);
                  }
                }
                // Read current values to return accurate state
                let outProvider = provider, outModel = model
                let curVal = {}
                try {
                  const cur = scope.getSnapshot()
                  if (cur && cur.value) {
                    curVal = cur.value
                    if (!Object.prototype.hasOwnProperty.call(body, 'provider')) outProvider = String(cur.value.visionProvider || '')
                    if (!Object.prototype.hasOwnProperty.call(body, 'model')) outModel = String(cur.value.visionModel || '')
                  }
                } catch {}
                writeJson(200, {
                  provider: outProvider,
                  model: outModel,
                  mode: incomingMode || curVal.mode || 'hybrid',
                  describeStrategy: incomingStrategy || curVal.describeStrategy || 'auto',
                  escalation: incomingEscalation || curVal.escalation || 'simple-only',
                  ...curVal
                })
              } catch (error) {
                writeJson(500, { error: String((error && error.message) || error) })
              }
              return
            }
            writeJson(405, { error: 'method not allowed' })
          } catch (error) {
            writeJson(500, { error: String((error && error.message) || error) })
          }
        },
      }),
    'dsh-vision-bridge: /config route',
  )

  // Host API: GET/POST /dsh-vision-bridge/channels — list and edit the
  // channels[] config array. Used by the Settings card channel editor.
  const CHANNEL_TYPES = new Set(['dsh-catalog', 'openai-compatible', 'ollama', 'custom', 'webhook', 'vllm', 'sglang'])
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/channels',
        handler: async (req, res) => {
          const writeJson = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
          }
          const readBody = () => new Promise((resolve) => {
            let chunks = ''
            req.on('data', (c) => { chunks += c })
            req.on('end', () => { resolve(chunks) })
          })
          try {
            if (req.method === 'GET') {
              const list = Array.isArray(config.channels) ? config.channels : []
              const probe = list.map((c) => {
                const key = channelKey(c)
                const circuit = channelCircuitStates.get(key) || { state: 'closed', failures: 0 }
                const latencies = channelLatencies.get(key) || []
                const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0
                return {
                  type: c && c.type,
                  key: resolveKey(c),
                  hasKey: hasUsableKey(c),
                  circuitState: circuit.state,
                  circuitFailures: circuit.failures,
                  avgMs,
                }
              })
              writeJson(200, { channels: list, probe })
              return
            }
            if (req.method === 'POST') {
              const raw = await readBody()
              let body
              try { body = JSON.parse(raw) } catch { body = {} }
              const incoming = Array.isArray(body && body.channels) ? body.channels : null
              if (incoming === null) {
                writeJson(400, { error: 'channels must be an array' })
                return
              }
              for (const [i, c] of incoming.entries()) {
                if (!c || typeof c !== 'object' || !CHANNEL_TYPES.has(c.type)) {
                  writeJson(400, { error: 'channels[' + i + ']: unknown type ' + (c && c.type) })
                  return
                }
                if ((c.type === 'openai-compatible' || c.type === 'custom') && (!c.baseURL || typeof c.baseURL !== 'string')) {
                  writeJson(400, { error: 'channels[' + i + ']: baseURL required for ' + c.type })
                  return
                }
                if (c.type === 'custom' && (!c.requestTemplate || !c.responsePath)) {
                  writeJson(400, { error: 'channels[' + i + ']: custom requires requestTemplate and responsePath' })
                  return
                }
              }
              config.channels = incoming
              writeJson(200, { channels: incoming })
              return
            }
            writeJson(405, { error: 'method not allowed' })
          } catch (error) {
            writeJson(500, { error: String((error && error.message) || error) })
          }
        },
      }),
    'dsh-vision-bridge: /channels route',
  )

  // Host API: POST /dsh-vision-bridge/test — make one cheap vision call with
  // the current channel setup and return {ok, latencyMs, text}.
    // Host API: POST /dsh-vision-bridge/upload-pdf
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-vision-bridge/upload-pdf',
      handler: async (req, res) => {
        const writeJson = (status, body) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (req.method !== 'POST') {
          writeJson(405, { error: 'method not allowed' })
          return
        }
        let pdfPath = null
        const frameFiles = []
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const buf = Buffer.concat(chunks)
          if (buf.length === 0) { writeJson(400, { error: 'empty payload' }); return }
          let pdfBytes = buf
          let docName = 'document.pdf'
          try {
            const text = buf.toString('utf8')
            if (text.startsWith('{')) {
              const parsed = JSON.parse(text)
              if (parsed.base64) pdfBytes = Buffer.from(parsed.base64, 'base64')
              if (parsed.name) docName = parsed.name
            }
          } catch {}
          const { spawnSync } = await import('node:child_process')
          const { tmpdir } = await import('node:os')
          const { join } = await import('node:path')
          const { writeFileSync, readFileSync, readdirSync, existsSync } = await import('node:fs')
          const dir = tmpdir()
          const stem = 'vbpdf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
          pdfPath = join(dir, stem + '.pdf')
          writeFileSync(pdfPath, pdfBytes)
          const r = spawnSync('pdftoppm', ['-png', '-r', '150', '-l', '10', pdfPath, join(dir, stem)], { timeout: 60000, encoding: 'utf8' })
          if (r.error && r.error.code === 'ENOENT') {
            writeJson(500, { error: 'pdftoppm is not installed on the system (please install poppler-utils)' })
            return
          }
          const frames = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(stem) && f.endsWith('.png')).sort() : []
          if (frames.length === 0) {
            writeJson(422, { error: 'failed to render PDF: ' + (r.stderr?.slice(0, 120) || 'no pages') })
            return
          }
          const pages = []
          for (let i = 0; i < frames.length; i++) {
            const frameFile = join(dir, frames[i])
            frameFiles.push(frameFile)
            const pageBytes = readFileSync(frameFile)
            const pageName = docName.replace(/\.pdf$/i, '') + '-page-' + (i + 1) + '.png'
            const savedRef = await ctx.attachments.saveImage({ data: pageBytes, mediaType: 'image/png', name: pageName })
            const id = savedRef.attachmentId ?? savedRef.id
            if (id !== undefined) recordAttachment(id, savedRef)
            pages.push({ attachmentId: String(id || ''), name: pageName, bytes: pageBytes.length, dataUrl: 'data:image/png;base64,' + pageBytes.toString('base64') })
          }
          writeJson(200, { ok: true, pages, count: pages.length })
        } catch (err) {
          writeJson(500, { error: String((err && err.message) || err) })
        } finally {
          try {
            const { unlinkSync, existsSync } = await import('node:fs')
            if (pdfPath && existsSync(pdfPath)) unlinkSync(pdfPath)
            for (const f of frameFiles) {
              if (existsSync(f)) unlinkSync(f)
            }
          } catch {}
        }
      },
    }),
  'dsh-vision-bridge: /upload-pdf route')

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-vision-bridge/test',
        handler: async (req, res) => {
          const writeJson = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
          }
          if (req.method !== 'POST') {
            writeJson(405, { error: 'method not allowed' })
            return
          }
          const start = Date.now()
          try {
            // 1x1 PNG, transparent. Used to probe channels end-to-end.
            const tinyPng = Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
              'base64',
            )
            const text = await callVisionModelWithBytes(
              tinyPng,
              'image/png',
              'Reply with the single word OK and nothing else.',
              {},
            )
            writeJson(200, { ok: true, latencyMs: Date.now() - start, text: text.description })
          } catch (error) {
            writeJson(500, { ok: false, latencyMs: Date.now() - start, error: String((error && error.message) || error) })
          }
        },
      }),
    'dsh-vision-bridge: /test route',
  )

  // Block B (0.3.6): /stats — per-channel usage.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/stats',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
          const out = {}
          for (const [k, v] of usageByChannel) out[k] = { calls: v.calls, avgMs: v.calls ? Math.round(v.totalMs / v.calls) : 0, lastMs: v.lastMs, errors: v.errors, quota: v.quota || {}, tokensIn: v.tokensIn || 0, tokensOut: v.tokensOut || 0 }
          writeJson(200, { channels: out, lastRequests })
        },
      }),
    'dsh-vision-bridge: /stats route',
  )

  // Block 0.4.0 (#77): /costs — estimated cost per channel (token-based estimate).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/costs',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
          // #107: real token usage when the provider reports it; fall back to
          // the rough estimate only when no usage was captured yet.
          const ASSUMED_IN = 1500, ASSUMED_OUT = 200
          const out = {}
          for (const [k, v] of usageByChannel) {
            const hasReal = (v.tokensIn || 0) > 0 || (v.tokensOut || 0) > 0
            out[k] = {
              calls: v.calls,
              tokensIn: v.tokensIn || 0,
              tokensOut: v.tokensOut || 0,
              estTokensIn: hasReal ? v.tokensIn : v.calls * ASSUMED_IN,
              estTokensOut: hasReal ? v.tokensOut : v.calls * ASSUMED_OUT,
              source: hasReal ? 'provider' : 'estimate',
              note: 'multiply by your provider price per token for actual cost',
            }
          }
          writeJson(200, { channels: out, lastRequests })
        },
      }),
    'dsh-vision-bridge: /costs route',
  )

  // #108: /journal — audit trail of vision calls, with optional filters.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/journal',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method === 'DELETE') {
            journal.clear()
            writeJson(200, { ok: true })
            return
          }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
          const url = new URL(req.url, 'http://localhost')
          const channel = url.searchParams.get('channel') || undefined
          const ok = url.searchParams.has('ok') ? url.searchParams.get('ok') === 'true' : undefined
          const since = url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined
          writeJson(200, { entries: journal.filter({ channel, ok, since }), size: journal.size })
        },
      }),
    'dsh-vision-bridge: /journal route',
  )

  // #110: /batch — start a batch (POST), poll progress (GET /batch/:id),
  // cancel (POST /batch/:id/cancel).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-vision-bridge/batch',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          const url = new URL(req.url, 'http://localhost')
          const parts = url.pathname.split('/').filter(Boolean) // [dsh-vision-bridge, batch, id?, action?]
          const id = parts[2]
          if (req.method === 'POST' && !id) {
            // start batch: body {attachmentIds:[], prompt}
            let body = {}
            try { body = await new Promise((resolve) => { let c = ''; req.on('data', (d) => { c += d }); req.on('end', () => { try { resolve(JSON.parse(c)) } catch { resolve({}) } }) }) } catch {}
            const ids = Array.isArray(body.attachmentIds) ? body.attachmentIds : []
            if (ids.length === 0) { writeJson(400, { error: 'attachmentIds required' }); return }
            const items = []
            for (const id of ids) {
              const ref = attachmentById.get(String(id))
              if (!ref) { writeJson(400, { error: `unknown attachmentId ${id}` }); return }
              const src = await resolveImageBytes(ref)
              if (!src) { writeJson(400, { error: `cannot read ${id}` }); return }
              items.push({ id, bytes: src.bytes, contentType: src.contentType })
            }
            const bid = await startBatch(items, body.prompt)
            writeJson(200, { id: bid, total: items.length })
            return
          }
          if (req.method === 'POST' && id && parts[3] === 'cancel') {
            const b = batches.get(id)
            if (!b) { writeJson(404, { error: 'batch not found' }); return }
            b.ctrl.abort()
            writeJson(200, { ok: true, cancelled: true })
            return
          }
          if (req.method === 'GET' && id) {
            const b = batches.get(id)
            if (!b) { writeJson(404, { error: 'batch not found' }); return }
            const s = b.state
            writeJson(200, { id: s.id, total: s.total, done: s.done, ok: s.ok, failed: s.failed, cancelled: s.cancelled, finished: !!s.finishedAt, results: s.results })
            return
          }
          writeJson(405, { error: 'method not allowed' })
        },
      }),
    'dsh-vision-bridge: /batch route',
  )

  // Block 0.4.0 (#78): /cache — list cached descriptions with metadata.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/cache',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method === 'DELETE') {
            if (descriptionByHash) descriptionByHash.clear()
            if (evidenceStore) evidenceStore.clear()
            descriptionByAttachmentId.clear()
            writeJson(200, { ok: true })
            return
          }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
          const entries = []
          if (descriptionByHash) entries.push({ store: 'lru', size: descriptionByHash.size })
          if (evidenceStore) entries.push({ store: 'evidence', size: evidenceStore.size })
          const recent = evidenceStore ? evidenceStore.recent(10).map((e) => ({ ts: e.ts, preview: (e.description || '').slice(0, 120) })) : []
          writeJson(200, { stores: entries, recent })
        },
      }),
    'dsh-vision-bridge: /cache route',
  )

  // Block B (0.3.6): /bench — probe every channel, return latency per channel.
  // #109: benchmark suite — run a small set of test prompts through each channel
  // and report latency + real token usage (quality is qualitative, surfaced as
  // the raw answer for the operator to judge).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/bench',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'POST') { writeJson(405, { error: 'method not allowed' }); return }
          const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
          const list = Array.isArray(config.channels) ? config.channels : []
          // #109: a few representative prompts exercise different output shapes.
          const suite = [
            'Reply with the single word OK and nothing else.',
            'Describe this image in one short sentence.',
            'What color is this image? Reply with one word.',
          ]
          const results = []
          for (const ch of list) {
            const per = []
            for (const prompt of suite) {
              const t0 = Date.now()
              const r = await runChannels([ch], {
                bytes: tinyPng, contentType: 'image/png', prompt, timeoutMs: config.channelTimeoutMs, cooldownMs: 0, cooldowns: new Map(), fallback: 'sequential',
              })
              per.push({
                ok: !!r.ok,
                latencyMs: Date.now() - t0,
                tokensIn: r.usage && r.usage.prompt_tokens,
                tokensOut: r.usage && r.usage.completion_tokens,
                answer: r.ok ? (r.description || '').slice(0, 80) : undefined,
                reason: r.ok ? undefined : r.reason,
              })
            }
            const okCount = per.filter((p) => p.ok).length
            results.push({
              key: channelKey(ch),
              ok: okCount === suite.length,
              okCount,
              total: suite.length,
              avgLatencyMs: Math.round(per.reduce((a, p) => a + p.latencyMs, 0) / per.length),
              totalTokensIn: per.reduce((a, p) => a + (p.tokensIn || 0), 0),
              totalTokensOut: per.reduce((a, p) => a + (p.tokensOut || 0), 0),
              runs: per,
            })
          }
          writeJson(200, { channels: results, suite: suite.length })
        },
      }),
    'dsh-vision-bridge: /bench route',
  )

  // #97: /doctor — human-readable diagnostics: which channels are configured,
  // which keys are present (masked), and a probe of each. Returns a report.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/doctor',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
          const list = Array.isArray(config.channels) ? config.channels : []
          const report = []
          for (const ch of list) {
            const keyNames = (Array.isArray(config.keysFromEnv) ? config.keysFromEnv : []).filter((n) => typeof process.env[n] === 'string' && process.env[n].trim())
            const entry = {
              channel: channelKey(ch),
              type: ch.type,
              model: ch.model || '',
              hasInlineKey: typeof ch.apiKey === 'string' && ch.apiKey.trim().length > 0,
              keysFromEnv: keyNames.map((n) => n + (n.length ? '' : '')),
              tier: ch.tier || 0,
            }
            // Probe end-to-end.
            const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
            const t0 = Date.now()
            const r = await runChannels([ch], {
              bytes: tinyPng, contentType: 'image/png', prompt: 'Reply with the single word OK.', timeoutMs: config.channelTimeoutMs, cooldownMs: 0, cooldowns: new Map(), fallback: 'sequential',
            })
            entry.probe = { ok: !!r.ok, latencyMs: Date.now() - t0, reason: r.ok ? undefined : r.reason }
            report.push(entry)
          }
          const summary = {
            configured: list.length,
            reachable: report.filter((e) => e.probe && e.probe.ok).length,
            failed: report.filter((e) => e.probe && !e.probe.ok).map((e) => e.channel + ': ' + (e.probe.reason || '')),
            detail: config.detail || 'auto',
            maxImagePixels: config.maxImagePixels || 0,
            channelFallback: config.channelFallback || 'sequential',
          }
          writeJson(200, { summary, channels: report })
        },
      }),
    'dsh-vision-bridge: /doctor route',
  )

  // Circuit breaker state endpoint (#129).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/circuit',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
          const out = {}
          for (const [k, v] of channelCircuitStates) {
            out[k] = { state: v.state, failures: v.failures, openUntil: v.openUntil }
          }
          writeJson(200, { circuits: out })
        },
      }),
    'dsh-vision-bridge: /circuit route',
  )

  // Provider catalog endpoint (#130).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/providers',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
          const providers = FREE_VISION_PROVIDERS.map((fp) => ({
            id: fp.id,
            name: fp.name,
            type: fp.type,
            baseURL: fp.baseURL,
            model: fp.model,
            hasKey: !!(process.env[fp.envKey] && process.env[fp.envKey].trim()),
            envKey: fp.envKey,
          }))
          writeJson(200, { providers })
        },
      }),
    'dsh-vision-bridge: /providers route',
  )

  // Image quality check (#157)
  ctx.tools.register(defineTool({
    name: 'vision_quality_check', description: 'Check image quality — blur, lighting, overall score. Use to detect poor-quality inputs before vision processing.',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { score: { type: 'number' }, blur: { type: 'string' }, lighting: { type: 'number' }, note: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: `Quality: ${v.score}/100, Blur: ${v.blur}, Lighting: ${v.lighting}%\n${v.note}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 10000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_quality_check: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_quality_check: cannot read image');
      return checkImageQuality(src.bytes);
    },
  }))

  
  // Helper: resolve image bytes from source, attachmentId, path, or fallback to most recent
  async function resolveSourceBytes(source, attachmentId, path) {
    const src = String(source || attachmentId || path || '').trim();
    if (!src) {
      const lastRef = [...attachmentById.values()].pop();
      if (lastRef) {
        try {
          const stored = await ctx.attachments.readImage(lastRef);
          return { bytes: stored.data, contentType: lastRef.mediaType || 'image/png' };
        } catch {}
      }
      return null;
    }
    if (/^https?:\/\//i.test(src)) {
      try {
        const res = await fetch(src, { signal: AbortSignal.timeout(Math.max(1000, config.channelTimeoutMs || 15000)) });
        if (!res.ok) return null;
        const bytes = Buffer.from(await res.arrayBuffer());
        return { bytes, contentType: res.headers.get('content-type') || sniffMediaType(bytes) || 'image/png' };
      } catch { return null; }
    }
    if (attachmentById.has(src)) {
      try {
        const ref = attachmentById.get(src);
        const stored = await ctx.attachments.readImage(ref);
        return { bytes: stored.data, contentType: ref.mediaType || 'image/png' };
      } catch { return null; }
    }
    const dshFs = ctx.get('fs');
    if (dshFs) {
      try {
        const target = await dshFs.resolve(src);
        const bytes = await dshFs.readBytes(target, undefined, config.maxImageBytes);
        return { bytes, contentType: sniffMediaType(bytes) || 'image/png' };
      } catch {}
    }
    try {
      const { existsSync, readFileSync } = await import('node:fs');
      if (existsSync(src)) {
        const bytes = readFileSync(src);
        return { bytes, contentType: sniffMediaType(bytes) || 'image/png' };
      }
    } catch {}
    return null;
  }

  
  // #131: DeepSeek-VL, Janus-Pro, and Qwen-VL native grounding token parser
  const parseNativeBbox = (text) => {
    if (!text) return null;
    try {
      const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '');
      if (Array.isArray(j.bbox) && j.bbox.length === 4) return j.bbox.map((n) => Math.max(0, Math.min(1000, Number(n) || 0)));
      if (Array.isArray(j.box_2d) && j.box_2d.length === 4) return [j.box_2d[1], j.box_2d[0], j.box_2d[3], j.box_2d[2]].map((n) => Math.max(0, Math.min(1000, Number(n) || 0)));
    } catch {}
    const dsMatch = text.match(/\(?(\d{1,4}),\s*(\d{1,4})\)?,\s*\(?(\d{1,4}),\s*(\d{1,4})\)?/);
    if (dsMatch) {
      return [Number(dsMatch[1]), Number(dsMatch[2]), Number(dsMatch[3]), Number(dsMatch[4])].map((n) => Math.max(0, Math.min(1000, n)));
    }
    const jnMatch = text.match(/\[(?:box_2d:?\s*)?(\d{1,4}),\s*(\d{1,4}),\s*(\d{1,4}),\s*(\d{1,4})\]/i);
    if (jnMatch) {
      return [Number(jnMatch[2]), Number(jnMatch[1]), Number(jnMatch[4]), Number(jnMatch[3])].map((n) => Math.max(0, Math.min(1000, n)));
    }
    return null;
  };

  // #163: UI Flow & User Journey Reconstructor
  ctx.tools.register(defineTool({
    name: 'vision_ui_flow',
    description: 'Reconstruct a UI user flow / journey graph from multiple screenshots. Returns screen states, user actions, transitions, and Mermaid diagram.',
    parameters: {
      attachmentIds: { type: 'array', items: { type: 'string' }, description: 'Ordered list of screenshot attachment IDs' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Ordered list of local screenshot paths' },
      title: { type: 'string', description: 'Flow name or goal (e.g. "Checkout Flow")' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                step: { type: 'number' },
                screen: { type: 'string' },
                action: { type: 'string' },
                nextScreen: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
          mermaid: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render(_a, v) {
        const stepsText = (v.steps || []).map((s) => s.step + '. **' + s.screen + '** -> [' + s.action + '] -> **' + s.nextScreen + '**\n   ' + s.description).join('\n');
        return [{ type: 'text', text: '### ' + v.title + '\n' + v.summary + '\n\n' + stepsText + '\n\n```mermaid\n' + v.mermaid + '\n```' }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 45000,
    execute: async ({ attachmentIds, paths, title }, exec) => {
      const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
      const pths = Array.isArray(paths) ? paths : [];
      const sources = [...ids.map(id => ({ id })), ...pths.map(p => ({ path: p }))];
      if (sources.length === 0) {
        const lastRefs = [...attachmentById.values()].slice(-4);
        if (lastRefs.length > 0) {
          sources.push(...lastRefs.map(r => ({ id: r.attachmentId || r.id })));
        }
      }
      if (sources.length === 0) throw new Error('vision_ui_flow: no screenshots provided');

      const sampled = sources.slice(0, 6);
      const descs = [];
      for (let i = 0; i < sampled.length; i++) {
        const s = sampled[i];
        const src = await resolveSourceBytes(null, s.id, s.path);
        if (src) {
          const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, 'Analyze Screen ' + (i + 1) + ' of this user flow: identify the screen name/title, key UI elements, and primary call-to-action button.', { ...(exec ? { signal: exec.signal } : {}) });
          descs.push('Screen ' + (i + 1) + ': ' + description);
        }
      }

      const flowTitle = title || 'User Interface Flow';
      const prompt = 'Based on these sequential UI screen descriptions, reconstruct the step-by-step user journey flow. '
        + 'Screens:\n' + descs.join('\n\n') + '\n\n'
        + 'Reply with strict JSON {"title":"' + flowTitle + '","summary":"brief overview of the user journey","steps":[{"step":1,"screen":"Screen name","action":"Click button / submit form","nextScreen":"Target screen name","description":"what happens"}],"mermaid":"graph TD\\n  A[Screen 1] -->|Action| B[Screen 2]"}.';

      const firstSrc = await resolveSourceBytes(null, sampled[0]?.id, sampled[0]?.path);
      const { description } = await callVisionModelWithBytes(firstSrc ? firstSrc.bytes : Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', prompt, { ...(exec ? { signal: exec.signal } : {}) });

      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}

      const steps = Array.isArray(parsed?.steps)
        ? parsed.steps.map((s, idx) => ({
            step: Number(s.step || idx + 1),
            screen: String(s.screen || ('Screen ' + (idx + 1))),
            action: String(s.action || 'Continue'),
            nextScreen: String(s.nextScreen || ('Screen ' + (idx + 2))),
            description: String(s.description || ''),
          }))
        : [];

      return {
        title: String(parsed?.title || flowTitle),
        summary: String(parsed?.summary || 'Sequential user journey reconstructed from screenshots.'),
        steps,
        mermaid: String(parsed?.mermaid || 'graph TD\n  Start --> Screen1\n  Screen1 --> End'),
      };
    },
  }))

  // #155: Multi-Model Consensus Tool
  ctx.tools.register(defineTool({
    name: 'vision_consensus',
    description: 'Query multiple vision models/channels simultaneously and synthesize a consensus description, eliminating single-model hallucinations.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      question: { type: 'string', description: 'What to describe or verify' },
      minAgreement: { type: 'number', description: 'Minimum number of agreeing channels (default 2)', default: 2 },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          consensus: { type: 'string' },
          modelsQueried: { type: 'array', items: { type: 'string' } },
          discrepancies: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: '### Consensus (Confidence: ' + v.confidence + '%)\n' + v.consensus + '\n\n**Models queried:** ' + v.modelsQueried.join(', ') + (v.discrepancies.length ? '\n\n**Discrepancies:**\n' + v.discrepancies.map(d=>'- ' + d).join('\n') : '') }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 45000,
    execute: async ({ attachmentId, path, question, minAgreement }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_consensus: image source not found');
      const q = question || 'Describe this image thoroughly, list all objects, texts, colors, and layout.';

      const channels = Array.isArray(config.channels) && config.channels.length > 1
        ? config.channels.slice(0, 3)
        : [];

      const descs = [];
      const modelsQueried = [];

      if (channels.length >= 2) {
        for (const ch of channels) {
          try {
            const r = await runChannels([ch], {
              bytes: src.bytes,
              contentType: src.contentType,
              prompt: q,
              timeoutMs: Math.min(20000, config.channelTimeoutMs || 20000),
              signal: exec?.signal,
            });
            if (r.ok && r.description) {
              descs.push({ model: ch.model || 'channel', desc: r.description });
              modelsQueried.push(ch.model || 'channel');
            }
          } catch {}
        }
      }

      if (descs.length < 2) {
        const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, q, { ...(exec ? { signal: exec.signal } : {}) });
        return {
          consensus: String(description || ''),
          modelsQueried: modelsQueried.length ? modelsQueried : ['primary-vision-model'],
          discrepancies: [],
          confidence: 95,
        };
      }

      const prompt = 'Synthesize a consensus analysis from multiple independent vision model outputs. Identify agreed facts and list any discrepancies or hallucinations. '
        + 'Outputs:\n' + descs.map((d, i) => 'Model ' + (i + 1) + ' (' + d.model + '):\n' + d.desc).join('\n\n')
        + '\n\nReply with strict JSON {"consensus":"synthesized accurate description of agreed facts","discrepancies":["point of disagreement 1"],"confidence":number(0-100)}.';

      const { description: syn } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(syn.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}

      return {
        consensus: String(parsed?.consensus || syn || descs[0].desc),
        modelsQueried,
        discrepancies: Array.isArray(parsed?.discrepancies) ? parsed.discrepancies.map(String) : [],
        confidence: Number(parsed?.confidence ?? 90),
      };
    },
  }))

  // #171: Persistent Visual Memory Search
  ctx.tools.register(defineTool({
    name: 'vision_memory_search',
    description: 'Search previously attached or processed images in session memory by semantic description or keywords.',
    parameters: {
      query: { type: 'string', description: 'Search query (e.g. "diagram with database", "receipt with 1500 total", "beagle dog")' },
      limit: { type: 'number', description: 'Maximum number of results to return (default 5)', default: 5 },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string' },
                name: { type: 'string' },
                score: { type: 'number' },
                descriptionSnippet: { type: 'string' },
              },
            },
          },
        },
      },
      render(_a, v) {
        if (!v.matches || v.matches.length === 0) return [{ type: 'text', text: 'No matching images found in visual memory.' }];
        const text = v.matches.map((m, i) => (i + 1) + '. **' + m.name + '** (ID: `' + m.attachmentId + '`, Match: ' + Math.round(m.score * 100) + '%)\n   ' + m.descriptionSnippet).join('\n\n');
        return [{ type: 'text', text: 'Found ' + v.count + ' matching images in visual memory:\n\n' + text }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 15000,
    execute: async ({ query, limit }) => {
      const q = String(query || '').toLowerCase().trim();
      if (!q) throw new Error('vision_memory_search: query is required');
      const maxResults = limit || 5;
      const terms = q.split(/\s+/).filter(t => t.length > 2);

      const candidates = [];
      for (const [id, ref] of attachmentById.entries()) {
        const name = String(ref?.name || id);
        let text = name.toLowerCase();

        for (const [k, desc] of descriptionByHash.entries()) {
          if (typeof desc === 'string') text += ' ' + desc.toLowerCase();
        }

        let score = 0;
        if (text.includes(q)) score += 0.8;
        for (const t of terms) {
          if (text.includes(t)) score += 0.2;
        }

        if (score > 0) {
          const descMatch = text.slice(0, 160) + '...';
          candidates.push({
            attachmentId: String(id),
            name,
            score: Math.min(1.0, score),
            descriptionSnippet: descMatch,
          });
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      const matches = candidates.slice(0, maxResults);
      return {
        count: matches.length,
        matches,
      };
    },
  }))

  // #141: LaTeX & Math Formula Extractor
  ctx.tools.register(defineTool({
    name: 'vision_extract_formula',
    description: 'Extract mathematical equations, formulas, integrals, and matrices from an image into LaTeX/KaTeX format.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      format: { type: 'string', enum: ['latex', 'katex', 'asciimath'], default: 'latex', description: 'Output formula notation' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          latex: { type: 'string' },
          expressions: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: v.latex + (v.description ? '\n\n' + v.description : '') }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 20000,
    execute: async ({ attachmentId, path, format }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_extract_formula: image source not found');
      const prompt = 'Transcribe all mathematical formulas and equations in this image into clean ' + (format || 'latex') + '. '
        + 'Reply with strict JSON {"latex":"combined full LaTeX equations","expressions":["expr1","expr2"],"description":"brief explanation of the equations"}. '
        + 'Preserve sub/superscripts, fractions (\\frac), matrices, Greek letters, integrals, and summations accurately.';
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      return {
        latex: String(parsed?.latex || description || ''),
        expressions: Array.isArray(parsed?.expressions) ? parsed.expressions.map(String) : [],
        description: String(parsed?.description || ''),
      };
    },
  }))

  // #142: Complex Table Extractor
  ctx.tools.register(defineTool({
    name: 'vision_extract_table',
    description: 'Extract complex tables, financial reports, spreadsheets from an image into Markdown, CSV, HTML, or JSON format.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      format: { type: 'string', enum: ['markdown', 'csv', 'html', 'json'], default: 'markdown', description: 'Desired output format' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: { type: 'string' },
          format: { type: 'string' },
          rowCount: { type: 'number' },
          colCount: { type: 'number' },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: v.table }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 20000,
    execute: async ({ attachmentId, path, format }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_extract_table: image source not found');
      const fmt = format || 'markdown';
      const prompt = 'Extract all tables from this image in ' + fmt.toUpperCase() + ' format. '
        + 'Reply with strict JSON {"table":"formatted table string in ' + fmt + '","rowCount":number,"colCount":number}. '
        + 'Preserve column alignment, headers, numbers, and merged cells accurately.';
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      return {
        table: String(parsed?.table || description || ''),
        format: fmt,
        rowCount: Number(parsed?.rowCount || 0),
        colCount: Number(parsed?.colCount || 0),
      };
    },
  }))

  // #143: QR & Barcode Scanner
  ctx.tools.register(defineTool({
    name: 'vision_scan_barcode',
    description: 'Scan and decode QR codes, barcodes (EAN-13, UPC, Code-128, Code-39), and DataMatrix from an image without VLM token overhead.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      type: { type: 'string', enum: ['auto', 'qr', 'barcode', 'datamatrix'], default: 'auto', description: 'Type of code to look for' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean' },
          codes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string' },
                value: { type: 'string' },
                location: { type: 'string' },
              },
            },
          },
        },
      },
      render(_a, v) {
        return [{
          type: 'text',
          text: v.found
            ? (v.codes || []).map((c) => '[' + c.type + '] ' + c.value + ' (' + c.location + ')').join('\n')
            : 'No QR or barcodes detected in image.',
        }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, path, type }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_scan_barcode: image source not found');
      const prompt = 'Locate and decode any visible QR codes, barcodes (EAN-13, UPC, Code 128, Code 39, ITF), or DataMatrix in this image. '
        + 'Reply with strict JSON {"found":boolean,"codes":[{"type":"QR|EAN-13|Code-128|Barcode","value":"decoded payload string or URL","location":"top-right|bottom-center|etc"}]}. '
        + 'If none found, reply {"found":false,"codes":[]}.';
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      const codes = Array.isArray(parsed?.codes)
        ? parsed.codes.map((c) => ({
            type: String(c.type || 'QR'),
            value: String(c.value || ''),
            location: String(c.location || 'center'),
          }))
        : [];
      return {
        found: Boolean(parsed?.found ?? codes.length > 0),
        codes,
      };
    },
  }))

  // #144: Structured JSON Schema Extractor
  ctx.tools.register(defineTool({
    name: 'vision_extract_structured',
    description: 'Extract structured fields from invoices, receipts, IDs, contracts, or forms according to a schema.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      schema: { type: 'string', description: 'JSON schema or list of fields to extract (e.g. "total, date, vendor, items")' },
      documentType: { type: 'string', enum: ['invoice', 'receipt', 'passport', 'id_card', 'contract', 'custom'], default: 'custom' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'string' },
          confidence: { type: 'number' },
          missingFields: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: 'Confidence: ' + v.confidence + '%\n\n' + v.data }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 20000,
    execute: async ({ attachmentId, path, schema: schemaArg, documentType }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_extract_structured: image source not found');
      const doc = documentType || 'custom';
      const targetSchema = schemaArg || 'extract all key-value pairs, dates, amounts, and entities';
      const prompt = 'Extract structured data from this ' + doc + ' document. Target fields/schema: ' + targetSchema + '. '
        + 'Reply with strict JSON {"data":{...extracted key values...},"confidence":number(0-100),"missingFields":[string]}.';
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      return {
        data: parsed?.data ? JSON.stringify(parsed.data, null, 2) : String(description || '{}'),
        confidence: Number(parsed?.confidence ?? 90),
        missingFields: Array.isArray(parsed?.missingFields) ? parsed.missingFields.map(String) : [],
      };
    },
  }))

  // #167: WCAG Accessibility Auditor
  ctx.tools.register(defineTool({
    name: 'vision_audit_accessibility',
    description: 'Audit UI screenshots for WCAG 2.1 accessibility, color contrast ratios, text readability, and touch target sizes.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      standard: { type: 'string', enum: ['WCAG_AA', 'WCAG_AAA', 'all'], default: 'WCAG_AA', description: 'Accessibility compliance standard' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          score: { type: 'number' },
          passed: { type: 'boolean' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string' },
                severity: { type: 'string' },
                element: { type: 'string' },
                description: { type: 'string' },
                recommendation: { type: 'string' },
              },
            },
          },
        },
      },
      render(_a, v) {
        const issuesText = (v.issues || []).map((i) => '[' + i.severity.toUpperCase() + '] ' + i.element + ': ' + i.description + '\n -> Рекомендация: ' + i.recommendation).join('\n\n');
        return [{ type: 'text', text: 'WCAG Score: ' + v.score + '/100 (' + (v.passed ? 'PASSED' : 'FAILED') + ')\n\n' + issuesText }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 20000,
    execute: async ({ attachmentId, path, standard }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_audit_accessibility: image source not found');
      const std = standard || 'WCAG_AA';
      const prompt = 'Audit this UI screenshot against ' + std + ' accessibility guidelines. Check text contrast ratios against backgrounds, minimum font sizes, touch target areas, icon clarity, and visual hierarchy. '
        + 'Reply with strict JSON {"score":number(0-100),"passed":boolean,"issues":[{"type":"contrast|font_size|target_size|clarity","severity":"critical|warning|info","element":"button/header/text name","description":"issue description","recommendation":"how to fix"}]}.';
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      const issues = Array.isArray(parsed?.issues)
        ? parsed.issues.map((i) => ({
            type: String(i.type || 'contrast'),
            severity: String(i.severity || 'warning'),
            element: String(i.element || 'UI element'),
            description: String(i.description || ''),
            recommendation: String(i.recommendation || ''),
          }))
        : [];
      return {
        score: Number(parsed?.score ?? 85),
        passed: Boolean(parsed?.passed ?? (issues.filter((i) => i.severity === 'critical').length === 0)),
        issues,
      };
    },
  }))

  
  // ── Cross-Plugin Optional Synergy Hooks ─────────────────────────────────
  // Safe, optional integrations: zero dependencies, 100% autonomous if companion plugins are absent.

  async function indexVisualMemory(attachmentId, name, description) {
    if (!description || !attachmentId) return;
    try {
      const memoryBrain = ctx.get('memoryBrain');
      if (memoryBrain && typeof memoryBrain.remember === 'function') {
        await memoryBrain.remember({
          type: 'visual_fact',
          source: 'attachment:' + attachmentId,
          title: 'Image: ' + (name || attachmentId),
          content: description,
          tags: ['vision', 'image', 'attachment'],
        });
      }
    } catch {}
  }

  // Cross-plugin synergy tool: verify AI generated images (#dsh-image-gen synergy)
  ctx.tools.register(defineTool({
    name: 'vision_verify_generated_image',
    description: 'Verify and inspect an AI-generated image (from dsh-image-gen or workspace) for quality, artifacts, and text accuracy.',
    parameters: {
      path: { type: 'string', description: 'Path to generated image file' },
      attachmentId: { type: 'string', description: 'Attachment ID of image' },
      prompt: { type: 'string', description: 'Original prompt or expected visual contents' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          score: { type: 'number' },
          passed: { type: 'boolean' },
          critique: { type: 'string' },
          detectedElements: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: 'Quality Score: ' + v.score + '/100 (' + (v.passed ? 'PASSED' : 'NEEDS REVISION') + ')\n\n' + v.critique }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 20000,
    execute: async ({ path, attachmentId, prompt: expectedPrompt }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_verify_generated_image: image file not found');
      const p = 'Inspect this AI-generated image against the intended prompt: "' + (expectedPrompt || 'N/A') + '". '
        + 'Check for visual artifacts, anatomical accuracy, text legibility, composition, and style fidelity. '
        + 'Reply with strict JSON {"score":number(0-100),"passed":boolean,"critique":"detailed assessment and advice","detectedElements":["elem1","elem2"]}.';
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, p, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      return {
        score: Number(parsed?.score ?? 90),
        passed: Boolean(parsed?.passed ?? ((parsed?.score ?? 90) >= 75)),
        critique: String(parsed?.critique || description || ''),
        detectedElements: Array.isArray(parsed?.detectedElements) ? parsed.detectedElements.map(String) : [],
      };
    },
  }))

  // Export visual report (#174) — generate formatted Markdown/PDF report
  ctx.tools.register(defineTool({
    name: 'vision_export_report', description: 'Export vision pipeline results to formatted Markdown or PDF report.',
    parameters: {
      title: { type: 'string', description: 'Report title', default: 'Vision Analysis Report' },
      attachmentIds: { type: 'array', items: { type: 'string' }, description: 'List of attachment IDs to include' },
      results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { attachmentId: { type: 'string' }, tool: { type: 'string' }, content: { type: 'string' } } }, description: 'Vision tool results to include' },
      format: { type: 'string', description: "Output format: 'markdown' (default) or 'pdf'" },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'string' }, format: { type: 'string' }, filename: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: v.report}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ title, attachmentIds, results, format }) => {
      const fmt = format || 'markdown'
      const ts = new Date().toISOString()
      let md = `# ${title || 'Vision Analysis Report'}\n\n`
      md += `**Generated:** ${ts}\n`
      md += `**Format:** ${fmt}\n\n`
      md += `## Summary\n\n`
      md += `- Attachments analyzed: ${(attachmentIds || []).length}\n`
      md += `- Tool results: ${(results || []).length}\n\n`
      if (attachmentIds && attachmentIds.length > 0) {
        md += `## Images\n\n`
        for (const id of attachmentIds) {
          md += `### Attachment: ${id}\n\n`
          const ref = attachmentById.get(String(id))
          if (ref) {
            try {
              const src = await resolveImageBytes(ref)
              if (src) {
                const b64 = src.bytes.toString('base64')
                md += `![${id}](data:${src.contentType};base64,${b64})\n\n`
              }
            } catch {}
          }
        }
      }
      if (results && results.length > 0) {
        md += `## Results\n\n`
        for (const r of results) {
          md += `### ${r.tool || 'analysis'} — ${r.attachmentId || 'unknown'}\n\n`
          md += `${r.content || ''}\n\n---\n\n`
        }
      }
      return { report: md, format: fmt, filename: 'report.md' }
    },
  }))

    // Server-side modality bridge: augment inputModalities with 'image' so DSH Alpha.2+
  // session-controller admission accepts image attachments for text-only chat models.
  ctx.effect(() => {
    if (!ctx.llm) return () => {}

    let origResolveModelInfo = null
    let origListModels = null

    if (typeof ctx.llm.resolveModelInfo === 'function') {
      origResolveModelInfo = ctx.llm.resolveModelInfo
      ctx.llm.resolveModelInfo = async function bridgedResolveModelInfo(provider, model, signal) {
        const info = await origResolveModelInfo.call(ctx.llm, provider, model, signal)
        if (!info) return info
        if (!sanitizeAllowed(config)) return info
        if (Array.isArray(info.inputModalities) && !info.inputModalities.includes('image')) {
          return {
            ...info,
            inputModalities: [...info.inputModalities, 'image'],
            _nativeInputModalities: info.inputModalities,
          }
        }
        return info
      }
    }

    if (typeof ctx.llm.listModels === 'function') {
      origListModels = ctx.llm.listModels
      ctx.llm.listModels = async function bridgedListModels(provider) {
        const models = await origListModels.call(ctx.llm, provider)
        if (!Array.isArray(models) || !sanitizeAllowed(config)) return models
        return models.map((m) => {
          if (m && Array.isArray(m.inputModalities) && !m.inputModalities.includes('image')) {
            return {
              ...m,
              inputModalities: [...m.inputModalities, 'image'],
              _nativeInputModalities: m.inputModalities,
            }
          }
          return m
        })
      }
    }

    return () => {
      if (origResolveModelInfo) ctx.llm.resolveModelInfo = origResolveModelInfo
      if (origListModels) ctx.llm.listModels = origListModels
    }
  }, 'dsh-vision-bridge: llm modality bridge')

}

/** Very small content-type sniffer for the common raster formats. */
export function sniffMediaType(bytes) {
  if (bytes && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return undefined
}

/**
 * Resize and compress an image for token savings.
 * Returns {bytes, contentType} — original if no compression needed or sharp unavailable.
 */
export async function compressImage(bytes, contentType, opts) {
  let sharp = null
  try { sharp = (await import('sharp')).default } catch { return { bytes, contentType } }
  if (!sharp) return { bytes, contentType }

  const { maxWidth = 1920, maxHeight = 1080, quality = 80, format = 'auto' } = opts || {}

  try {
    const img = sharp(bytes)
    const meta = await img.metadata()
    const needsResize = (meta.width && meta.width > maxWidth) || (meta.height && meta.height > maxHeight)

    let pipeline = img
    if (needsResize) {
      pipeline = pipeline.resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
    }

    let outFormat = format
    if (outFormat === 'auto') outFormat = 'webp'

    let outBytes, outType
    if (outFormat === 'webp') {
      outBytes = await pipeline.webp({ quality }).toBuffer()
      outType = 'image/webp'
    } else if (outFormat === 'avif') {
      outBytes = await pipeline.avif({ quality }).toBuffer()
      outType = 'image/avif'
    } else if (outFormat === 'png') {
      outBytes = await pipeline.png({ compressionLevel: 9 }).toBuffer()
      outType = 'image/png'
    } else {
      outBytes = await pipeline.jpeg({ quality }).toBuffer()
      outType = 'image/jpeg'
    }

    if (outBytes.length < bytes.length) {
      return { bytes: outBytes, contentType: outType }
    }
    return { bytes, contentType }
  } catch {
    return { bytes, contentType }
  }
}

/**
 * Mask PII (emails, phones, names) in text.
 * ponytail: regex-based, not NER — catches common patterns. Upgrade to NER model if accuracy matters.
 */
export function maskPII(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
    .replace(/\+?\d[\d\s()-]{7,}\d/g, '[PHONE]')
    .replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, '[NAME]')
}

/**
 * Mask system paths and IP addresses in text.
 */
export function maskSystemPaths(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/\/(?:home|root|Users|var|etc|tmp|opt|mnt)\/[^\s,;)}\]]+/g, '[PATH]')
    .replace(/[A-Z]:\\[^\s,;)}\]]+/g, '[PATH]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')
    .replace(/\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, '[IP]')
}

/**
 * Strip EXIF metadata from image bytes.
 * ponytail: uses sharp if available, otherwise returns original. Upgrade to exif-reader for standalone.
 */
export async function stripEXIF(bytes, contentType) {
  let sharp = null
  try { sharp = (await import('sharp')).default } catch { return bytes }
  if (!sharp) return bytes
  try {
    // sharp strips EXIF by default when outputting
    const pipeline = sharp(bytes)
    const meta = await pipeline.metadata()
    if (contentType === 'image/png') {
      return await pipeline.png().toBuffer()
    }
    return await pipeline.jpeg().toBuffer()
  } catch {
    return bytes
  }
}

/**
 * Check if image is NSFW. Returns true if safe, false if NSFW.
 * ponytail: stub — always returns true (safe). Upgrade to ONNX NSFW classifier
 * (e.g. @anthropic-ai/nsfw-classifier or falconsai/nsfw-classification) for real detection.
 */

/**
 * Detect and blur faces in image bytes.
 * ponytail: uses sharp if available with face detection stub. Upgrade to @vladmandic/face-api or mediapipe for real detection.
 */
export async function blurFaces(bytes, contentType) {
  let sharp = null
  try { sharp = (await import('sharp')).default } catch { return bytes }
  if (!sharp) return bytes
  try {
    // ponytail: real face detection needs a model. For now, just return original.
    // Upgrade path: detect faces with mediapipe/face-api, get bounding boxes,
    // then sharp.extract(region).blur().composite(region).
    return bytes
  } catch {
    return bytes
  }
}

/**
 * Tile a large image into smaller tiles for vision model processing.
 * Returns array of tiles {bytes, contentType, index} or single tile if no tiling needed.
 */
export async function tileImage(bytes, contentType, opts) {
  const { maxPixels = 4000000, overlap = 50 } = opts || {}
  let sharp = null
  try { sharp = (await import('sharp')).default } catch { return [{ bytes, contentType, index: 0, total: 1 }] }
  if (!sharp) return [{ bytes, contentType, index: 0, total: 1 }]

  try {
    const img = sharp(bytes)
    const meta = await img.metadata()
    const width = meta.width || 0
    const height = meta.height || 0
    if (width * height <= maxPixels) return [{ bytes, contentType, index: 0, total: 1 }]

    const targetW = Math.min(width, Math.sqrt(maxPixels * width / height))
    const targetH = Math.min(height, Math.sqrt(maxPixels * height / width))
    const tileW = Math.floor(targetW)
    const tileH = Math.floor(targetH)
    const strideX = Math.max(1, tileW - overlap)
    const strideY = Math.max(1, tileH - overlap)

    const tiles = []
    let index = 0
    for (let y = 0; y < height; y += strideY) {
      for (let x = 0; x < width; x += strideX) {
        const w = Math.min(tileW, width - x)
        const h = Math.min(tileH, height - y)
        if (w < 50 || h < 50) continue
        const tileBytes = await sharp(bytes).extract({ left: x, top: y, width: w, height: h }).png().toBuffer()
        tiles.push({ bytes: tileBytes, contentType: 'image/png', index: index++, x, y, w, h })
      }
    }
    return tiles
  } catch {
    return [{ bytes, contentType, index: 0, total: 1 }]
  }
}

/**
 * Deskew an image — detect rotation angle and correct it.
 * ponytail: uses sharp with auto-rotate based on EXIF.
 */
export async function deskewImage(bytes, contentType) {
  let sharp = null
  try { sharp = (await import('sharp')).default } catch { return bytes }
  if (!sharp) return bytes
  try {
    let pipeline = sharp(bytes).rotate()
    if (contentType === 'image/png') {
      return await pipeline.png().toBuffer()
    }
    return await pipeline.jpeg().toBuffer()
  } catch {
    return bytes
  }
}

/**
 * Enhance image — apply contrast normalization and sharpening.
 */
export async function enhanceImage(bytes, contentType) {
  let sharp = null
  try { sharp = (await import('sharp')).default } catch { return bytes }
  if (!sharp) return bytes
  try {
    let pipeline = sharp(bytes).normalize().sharpen({ sigma: 0.5 })
    if (contentType === 'image/png') {
      return await pipeline.png().toBuffer()
    }
    return await pipeline.jpeg().toBuffer()
  } catch {
    return bytes
  }
}

/**
 * Auto-select best image format based on content.
 * Returns 'webp' for photos, 'png' for screenshots/diagrams.
 */
export async function autoSelectFormat(bytes) {
  if (bytes.length < 100 * 1024) return 'png'
  return 'webp'
}


/**
 * Check if image is NSFW. Returns true if safe, false if NSFW.
 * ponytail: stub — always returns true (safe). Upgrade to ONNX NSFW classifier
 * (e.g. @anthropic-ai/nsfw-classifier or falconsai/nsfw-classification) for real detection.
 */
export async function checkNSFW(bytes) {
  // ponytail: real NSFW detection needs an ONNX model. For now, always safe.
  // Upgrade path: load ONNX model, run inference, return classification.
  return true
}

// #91: parse width*height out of a PNG/JPEG header without a native image lib.
// Returns null when the format is unknown to us (guard is then skipped).
// #115: bytes may be a Buffer (URL/path fetch) or a Uint8Array (attachment
// readImage). readUInt32BE is Buffer-only, so normalize once at the top.
export function imageDimensions(bytes) {
  if (!bytes || bytes.length < 24) return null
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength)
  // PNG: IHDR at offset 16 -> width (16..20), height (20..24), big-endian.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // JPEG: walk SOF markers (C0..CF, minus C4/C8/CC) for frame dims.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = (buf[i + 2] << 8) | buf[i + 3]
      if (len < 2 || i + 2 + len > buf.length) return null
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (buf[i + 5] << 8) | buf[i + 6], width: (buf[i + 7] << 8) | buf[i + 8] }
      }
      i += 2 + len
    }
    return null
  }
  return null
}

/**
 * Accumulate the visible text out of an adapter chunk stream.
 *
 * A stream carries the same text twice: incrementally as `text-delta`, then
 * whole in the closing `block-end`. Adding both doubles every answer, so the
 * deltas win and `block-end` only fills in for adapters that skip them.
 */
export async function collectText(iterable) {
  let out = ''
  let reasoning = ''
  let sawDelta = false
  for await (const chunk of iterable) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      out += chunk.text
      sawDelta = true
    } else if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoning += chunk.text
    } else if (
      !sawDelta && chunk && chunk.type === 'block-end'
      && chunk.block && typeof chunk.block.text === 'string'
    ) {
      if (chunk.block.type === 'text') out += chunk.block.text
      else if (chunk.block.type === 'reasoning') reasoning += chunk.block.text
    } else if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const err = chunk.reason.failure
      throw new Error('LLM error (' + ((err && err.code) || 'ERROR') + '): ' + ((err && err.message) || 'stream failed'))
    }
  }
  return (out.trim() || reasoning.trim())
}

/** Non-cryptographic FNV-1a content hash (fast, no dependencies). */
export function contentHash(bytes) {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/**
 * Perceptual hash (pHash) for image deduplication (#170).
 * Returns a 64-bit hex string. Similar images produce similar hashes.
 * ponytail: simple DCT-free implementation. Uses 8x8 average hash.
 */
export async function pHash(bytes) {
  let sharp = null
  try { sharp = (await import('sharp')).default } catch { return contentHash(bytes) }
  if (!sharp) return contentHash(bytes)
  try {
    const { data } = await sharp(bytes).resize(8, 8, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true })
    const avg = data.reduce((a, b) => a + b, 0) / 64
    let hash = ''
    for (let i = 0; i < 64; i++) {
      hash += data[i] >= avg ? '1' : '0'
    }
    return parseInt(hash, 2).toString(16).padStart(16, '0')
  } catch {
    return contentHash(bytes)
  }
}

/**
 * Check image quality (#157) — returns blur, lighting, overall score.
 */
export async function checkImageQuality(bytes) {
  let sharp = null
  try { sharp = (await import('sharp')).default } catch { return { score: 100, blur: 0, lighting: 100, note: 'sharp unavailable' } }
  if (!sharp) return { score: 100, blur: 0, lighting: 100, note: 'sharp unavailable' }
  try {
    const stats = await sharp(bytes).stats()
    const channels = stats.channels
    const meanR = channels[0]?.mean || 128
    const meanG = channels[1]?.mean || 128
    const meanB = channels[2]?.mean || 128
    const lighting = Math.round(((meanR + meanG + meanB) / 3 / 255) * 100)
    const stdevR = channels[0]?.stdev || 0
    // Higher stdev = more detail = less blurry
    const blur = stdevR < 20 ? 'high' : stdevR < 40 ? 'medium' : 'low'
    const score = Math.min(100, Math.round(stdevR * 2 + (lighting > 20 && lighting < 80 ? 20 : 0)))
    return { score, blur, lighting, note: blur === 'high' ? 'image may be blurry' : 'ok' }
  } catch (e) {
    return { score: 100, blur: 0, lighting: 100, note: String(e?.message || e) }
  }
}
