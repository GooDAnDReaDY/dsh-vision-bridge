// dsh-vision-bridge — pure core (#206).
//
// Config schema and every module-level pure helper (masking, fetch policy,
// image math and hashing, stream/text utils) live here; lib/index.js keeps
// the cordis apply() (tools, routes, listeners) and re-exports this module
// for backwards compatibility with existing test imports.

import z from '@deepseek-ai/schemastery'
import { runProcessAsync, isBinaryAvailable } from './process.js'

export function isTrustedSettingsRequest(request) {
  if (!request || !request.headers) return false
  return request.headers['sec-fetch-site'] !== 'cross-site'
}

export function maskApiKey(key) {
  if (!key || typeof key !== 'string') return ''
  const trimmed = key.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 8) return '********'
  return trimmed.slice(0, 4) + '...' + trimmed.slice(-4)
}

export function isMaskedKey(key) {
  return typeof key === 'string' && (key.includes('...') || key === '********')
}

/**
 * #211: resolve a channel's key through apiKeyRef indirection. An explicit
 * channel apiKey always wins; otherwise the credential service (`resolveCred`)
 * is asked for the referenced name, falling back to the named environment
 * variable. Returns the channel unchanged when nothing resolves, so callers
 * can apply it transparently to every channel entry.
 */
export async function resolveChannelApiKey(channel, resolveCred, env = process.env) {
  if (!channel || !channel.apiKeyRef) return channel
  if (typeof channel.apiKey === 'string' && channel.apiKey.trim()) return channel
  const name = String(channel.apiKeyRef).trim()
  if (!name) return channel
  let key = ''
  if (typeof resolveCred === 'function') {
    try { key = String((await resolveCred(name)) || '') } catch {}
  }
  if (!key && env && typeof env[name] === 'string') key = env[name]
  if (!key.trim()) return channel
  return { ...channel, apiKey: key }
}

export async function runLocalOCR(bytes, contentType = 'image/png', lang = 'rus+eng') {
  try {
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { writeFileSync, unlinkSync } = await import('node:fs')
    const hasTess = await isBinaryAvailable('tesseract')
    if (hasTess) {
      const stem = 'vbtess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
      const imgPath = join(tmpdir(), stem + '.png')
      writeFileSync(imgPath, bytes)
      try {
        const r = await runProcessAsync('tesseract', [imgPath, 'stdout', '-l', lang, '--psm', '3'], { timeout: 15000 })
        const text = (r.stdout || '').trim()
        if (text) return text
      } finally {
        try { unlinkSync(imgPath) } catch {}
      }
    }
  } catch {}
  return ''
}

export const FREE_VISION_PROVIDERS = [
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
  // #202: server-side fetches of model-supplied URLs refuse private/loopback/
  // link-local hosts. Operators who need an internal endpoint name it here
  // (exact hostname match); an empty list means "any public host".
  allowedUrlHosts: z
    .array(z.string())
    .description('If non-empty, ONLY http(s) URLs on these exact hosts may be fetched server-side — this is also the way to deliberately re-allow an internal endpoint. Empty = any public host; private/loopback/link-local hosts are always refused otherwise.')
    .default([]),
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
  // #242: hide the compensation tools from agents whose chat model already
  // supports images natively — they exist only to give a text-only model sight.
  hideRedundantTools: z
    .boolean()
    .description('When the active chat model supports images natively, hide the bridge/compensation tools from that agent and keep only the extra instruments (media, documents, workflow).')
    .default(true),
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
  // #228: hard cap for PDF uploads handed to /upload-pdf.
  // #241: how many images one attach call may publish (PDF pages, video
  // frames, files). Hard ceiling 32 in lib/tools/attach.js.
  attachMaxItems: z
    .number()
    .description('Maximum attachments published by one vision_attach_* call (PDF pages, video frames, images).')
    .default(8),
  maxPdfBytes: z
    .number()
    .description('Upper bound in bytes for a PDF uploaded through /upload-pdf. Oversized payloads are rejected with 413 before buffering.')
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
  stripEXIF: z
    .boolean()
    .description('Strip EXIF metadata from images before sending to vision model.')
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
  return allowedDirs.some((d) => {
    // Boundary-aware prefix match: '/etc' must not allow '/etcpasswd'.
    const dir = String(d).replace(/[\\/]+$/, '')
    if (!dir) return false
    return p === dir || p.startsWith(dir + '/') || p.startsWith(dir + '\\')
  })
}

export function maskSecretsInError(msg) {
  if (typeof msg !== 'string') return msg
  return msg.replace(/(api[_-]?key\s*[:=]\s*)[^,\s]+/gi, '$1***')
}

/** True for IPv4/IPv6 addresses in loopback, private, link-local, CGNAT or
 *  unspecified ranges — hosts a server-side fetch must not contact (#202).
 *  Recognizes IPv4-mapped/translated forms too: ::ffff:a.b.c.d (dotted and
 *  hex) and the NAT64 prefix 64:ff9b::/96 (conservatively blocked). */
export function isPrivateIp(ip) {
  const s = String(ip || '').toLowerCase()
  if (s.includes(':')) {
    if (s === '::' || s === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(s)) return true // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(s)) return true // fe80::/10 link-local
    if (/^64:ff9b:/.test(s)) return true // 64:ff9b::/96 NAT64 — block conservatively
    // ::ffff:0:0/96 embeds an IPv4 address — check the embedded host.
    const mappedDotted = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
    if (mappedDotted) return isPrivateIp(mappedDotted[1])
    const mappedHex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16)
      const lo = parseInt(mappedHex[2], 16)
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return false
  }
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const octets = m.slice(1).map(Number)
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * #202: gate server-side fetches of model-supplied URLs. Refuses non-http(s)
 * schemes and hosts resolving into private/loopback/link-local ranges. When
 * `allowedHosts` is non-empty, only those exact hostnames are accepted and no
 * DNS lookup is performed. `opts.lookup` is injectable for offline tests.
 */
export async function isSafeFetchUrl(raw, opts = {}) {
  const allowList = Array.isArray(opts.allowedHosts)
    ? opts.allowedHosts.map((h) => String(h).toLowerCase().trim()).filter(Boolean)
    : []
  let u
  try { u = new URL(String(raw || '')) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = (u.hostname || '').toLowerCase()
  if (!host) return false
  if (allowList.length > 0) return allowList.includes(host)
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const { isIP } = await import('node:net')
  if (isIP(bare)) return !isPrivateIp(bare)
  const lookup = opts.lookup || (await import('node:dns')).promises.lookup
  try {
    const records = await lookup(bare, { all: true, verbatim: true })
    if (!records || records.length === 0) return false
    return records.every((r) => !isPrivateIp(r.address))
  } catch {
    return false
  }
}

/**
 * #202: fetch with the fetch policy re-applied to every redirect hop. A
 * public URL that 302s to a private address is refused instead of followed.
 * Known residual limitation: a DNS-rebinding host can pass validation and
 * then resolve to an internal address inside fetch itself (validation and
 * transfer resolve DNS independently); closing that fully requires pinning
 * the validated address, tracked for the docs/security sweep (#207).
 * `opts.fetch` is injectable for offline tests.
 */
export async function safeFetch(raw, opts = {}) {
  let url = String(raw || '')
  const doFetch = opts.fetch || fetch
  const init = opts.init || {}
  const maxRedirects = opts.maxRedirects == null ? 3 : opts.maxRedirects
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!(await isSafeFetchUrl(url, opts))) {
      throw new Error(`URL refused by fetch policy (#202): ${url}`)
    }
    const res = await doFetch(url, { ...init, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res
      url = new URL(location, url).toString()
      continue
    }
    return res
  }
  throw new Error('safeFetch: too many redirects (#202)')
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
export const VISION_PASS = Symbol.for('dsh-vision-bridge/pass')

/** Very small content-type sniffer for the common raster formats. */
export function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 3) return undefined
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  // RIFF....WEBP
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  // ISO-BMFF: ....ftypavif / ....ftypavis
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
    && bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && (bytes[11] === 0x66 || bytes[11] === 0x73)) return 'image/avif'
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
 * Scale a bbox from 0-1000 normalized coords to image pixels (#166).
 * x-coords scale by width, y-coords by height; clamped and rounded so the
 * rect stays inside the image. Returns [] for malformed input.
 */
export function scaleBbox(bbox, width, height) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return []
  const w = Number(width) > 0 ? Number(width) : 1000
  const h = Number(height) > 0 ? Number(height) : 1000
  const clampPx = (v, max) => Math.max(0, Math.min(max, Math.round(v)))
  const x1 = clampPx((Number(bbox[0]) || 0) / 1000 * w, w)
  const y1 = clampPx((Number(bbox[1]) || 0) / 1000 * h, h)
  const x2 = clampPx((Number(bbox[2]) || 0) / 1000 * w, w)
  const y2 = clampPx((Number(bbox[3]) || 0) / 1000 * h, h)
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
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
 * Encode a 64-bit bit-string ('0'/'1' x64) as exact 16-char hex.
 * The value exceeds Number.MAX_SAFE_INTEGER, so it is packed as two exact
 * 32-bit halves instead of one rounding parseInt call (#199).
 */
export function bits64ToHex(bits) {
  const hi = parseInt(bits.slice(0, 32), 2)
  const lo = parseInt(bits.slice(32), 2)
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0')
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
    // 64 bits exceed Number.MAX_SAFE_INTEGER — pack as two exact halves (#199).
    return bits64ToHex(hash)
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
