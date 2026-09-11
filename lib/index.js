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

import { runProcessAsync, isBinaryAvailable } from './process.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runChannels, discoverOllamaVisionModels, channelKey, getSortedChannels } from './channels.js'
import {
  registerCoreTools,
  registerGroundingTools,
  registerOcrTools,
  registerDocumentTools,
  registerAnalysisTools,
  registerMediaTools,
} from './tools/index.js'
import { createLru, descriptionCacheKey } from './cache.js'
import { EvidenceStore } from './evidence.js'
import { VisionJournal } from './journal.js'
import {
  Config,
  FREE_VISION_PROVIDERS,
  VISION_PASS,
  acceptsImages,
  blocksHaveImage,
  checkImageQuality,
  collectText,
  compressImage,
  contentHash,
  deskewImage,
  enhanceImage,
  imageDimensions,
  inject,
  isMaskedKey,
  isPathAllowed,
  isSafeFetchUrl,
  isTrustedSettingsRequest,
  maskApiKey,
  maskPII,
  maskSecretsInError,
  maskSystemPaths,
  name,
  pHash,
  resolveChannelApiKey,
  rewriteImagesDeep,
  runLocalOCR,
  safeFetch,
  sanitizeAllowed,
  scaleBbox,
  shouldBridgeForModel,
  sniffMediaType,
  stripEXIF,
} from './vision-core.js'

// #206: backwards-compatible re-exports — existing test imports and
// external consumers keep working against lib/index.js.
export {
  Config,
  FREE_VISION_PROVIDERS,
  VISION_PASS,
  acceptsImages,
  bits64ToHex,
  blocksHaveImage,
  checkImageQuality,
  collectText,
  compressImage,
  contentHash,
  deskewImage,
  enhanceImage,
  imageDimensions,
  inject,
  isMaskedKey,
  isPathAllowed,
  isPrivateIp,
  isSafeFetchUrl,
  isTrustedSettingsRequest,
  maskApiKey,
  maskPII,
  maskSecretsInError,
  maskSystemPaths,
  name,
  pHash,
  resolveChannelApiKey,
  rewriteImagesDeep,
  runLocalOCR,
  safeFetch,
  sanitizeAllowed,
  scaleBbox,
  shouldBridgeForModel,
  sniffMediaType,
  stripEXIF,
} from './vision-core.js'

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
  // #203-review: single choke point for prompt masking on every direct
  // llm.stream path that bypasses callVisionModelWithBytes.
  const effectivePrompt = (t) => (config.maskPII && typeof t === 'string' && t ? maskPII(t) : t)
  // #211: channels with apiKeyRef resolve their key at call time via the
  // credential service, falling back to the named environment variable, so
  // plaintext keys are no longer required in settings.
  const liveChannels = async () => {
    const list = Array.isArray(config.channels) ? config.channels : []
    let creds = null
    try { creds = ctx.get('credentials') } catch {}
    const resolveCred = creds && typeof creds.resolve === 'function' ? (n) => creds.resolve(n) : null
    const out = []
    for (const c of list) out.push(await resolveChannelApiKey(c, resolveCred))
    return out
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
  // #203: auditLog now actually gates the journal: 'off' records nothing (and
  // nothing hits the disk), 'errors' records failures only, 'all' every call.
  const journalAdd = (entry) => {
    if (config.auditLog === 'all' || (config.auditLog === 'errors' && entry.ok === false)) journal.add(entry)
  }
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
      'dsh-vision-bridge: no vision-capable model found in the LLM catalog. Add a vision model (input: [text, image]) in Settings -> Models, or set visionProvider/visionModel in the plugin settings.',
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
      // #227: results stay pollable for 10 minutes, then the record (and the
      // descriptions it holds) is released instead of growing the Map forever.
      setTimeout(() => batches.delete(id), 10 * 60 * 1000)
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
    // #203: maskPII now actually gates — PII is masked out of the prompt
    // before it reaches the vision model, the cache or the journal.
    if (config.maskPII && typeof question === 'string' && question) question = maskPII(question)
    // Image preprocessing pipeline (#145 #146 #147). #203-review: runs
    // regardless of the pixel guard — maxImagePixels=0 must not silently
    // disable deskew/enhance/stripEXIF/compress.
    if (config.deskew) {
      bytes = await deskewImage(bytes, contentType)
    }
    if (config.enhanceImage) {
      bytes = await enhanceImage(bytes, contentType)
    }
    // #203: stripEXIF now actually runs (sharp keeps only the pixel data).
    if (config.stripEXIF) {
      bytes = await stripEXIF(bytes, contentType)
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

    // #91: uniform pixel guard — reject oversized images before spending a call.
    if (config.maxImagePixels > 0) {
      const dims = imageDimensions(bytes)
      if (dims && dims.width > 0 && dims.height > 0 && dims.width * dims.height > config.maxImagePixels) {
        throw new Error(
          `dsh-vision-bridge: image ${dims.width}x${dims.height}px (${(dims.width * dims.height / 1e6).toFixed(1)}MP) exceeds the ${(config.maxImagePixels / 1e6).toFixed(1)}MP limit. Downscale the image before calling.`,
        )
      }
    }
    const detail = opts && opts.detail ? opts.detail : (config.detail || 'auto')
    // Channels-driven path (Issue #2). Empty config.channels = legacy path.
    // #211: resolve apiKeyRef indirection per call so credentials never have
    // to sit in the settings file.
    const configuredChannels = await liveChannels()
    if (configuredChannels.length > 0) {
      const modelHint = (configuredChannels.find((c) => c && c.model) || {}).model || 'channels'
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
      let orderedChannels = configuredChannels
      if (config.channelOrderMode === 'auto-latency') {
        // #211: sort the resolved list so apiKeyRef channels keep their keys.
        orderedChannels = getSortedChannels(configuredChannels, {
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
        journalAdd({ ok: true, channel: chKey, key: keyLabel, imageHash: contentHash(bytes), prompt: question.slice(0, 200), tokensIn: result.usage && result.usage.prompt_tokens, tokensOut: result.usage && result.usage.completion_tokens, latencyMs: Date.now() - t0 })
        // #88: expose meta.attempts (channel-level failover trace) to callers/UI.
        return { description: desc, cached: false, attempts: result.attempts, keyUsed: keyLabel, usage: result.usage }
      }
      bumpUsage(chKey, Date.now() - t0, false)
      // #108: journal the failure.
      journalAdd({ ok: false, channel: chKey, key: keyLabel, imageHash: contentHash(bytes), prompt: question.slice(0, 200), reason: result.reason, latencyMs: Date.now() - t0 })
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
    const t0 = Date.now()
    const chunks = ctx.llm.stream({
      ...(opts && opts.signal ? { signal: opts.signal } : {}),
      provider,
      model,
      messages: [{ role: 'user', content: blocks }],
      ...(config.timeoutMs > 0 ? { maxTokens: 1024 } : {}),
      [VISION_PASS]: true,
    })
    let text = ''
    try {
      text = await collectText(chunks)
    } catch (e) {
      // #203-review: the legacy path journals its failures as well.
      journalAdd({ ok: false, channel: 'dsh-catalog:' + provider + '/' + model, imageHash: contentHash(bytes), prompt: String(question).slice(0, 200), reason: String((e && e.message) || e).slice(0, 200), latencyMs: Date.now() - t0 })
      throw e
    }
    if (text && key) {
      descriptionByHash.set(key, text)
      if (evidenceStore) evidenceStore.set(key, text)
    }
    // #203-review: and its successes.
    journalAdd({ ok: true, channel: 'dsh-catalog:' + provider + '/' + model, imageHash: contentHash(bytes), prompt: String(question).slice(0, 200), latencyMs: Date.now() - t0 })
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
    const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : 'Describe this image.'

    // Auto-fallback: if no attachment/path specified, use the most recent attachment from the chat
    if (attachmentIds.length + paths.length + urls.length === 0) {
      const lastRef = [...attachmentById.values()].pop()
      if (lastRef) {
        const id = lastRef.attachmentId ?? lastRef.id
        if (id !== undefined) attachmentIds.push(String(id))
      }
    }

    if (attachmentIds.length + paths.length + urls.length === 0) {
      throw new Error('describe_image: pass attachmentIds (image ids from the conversation), paths (file paths) or urls (http(s) URLs).')
    }
    const fs = ctx.get('fs')
    const seenRefs = []
    let lastEntry = null
    for (const id of attachmentIds) {
      const ref = attachmentById.get(String(id))
      if (ref === undefined) {
        throw new Error(`describe_image: unknown attachment id "${id}". Take the id from the image marker/notification, or pass paths.`)
      }
      let stored
      try {
        stored = await ctx.attachments.readImage(ref)
      } catch (error) {
        throw new Error(`describe_image: failed to read attachment ${id} (${error && error.message ? error.message : String(error)})`)
      }
      if (stored.data.length > config.maxImageBytes) {
        throw new Error(`describe_image: attachment ${id} is too large (${stored.data.length} bytes, limit ${config.maxImageBytes}).`)
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
            { type: 'text', text: effectivePrompt(question) },
          ] }],
          ...(config.timeoutMs > 0 ? { maxTokens: 1024 } : {}),
        })
        const text = await collectText(chunks)
        entry = { description: text, provider, model, cached: false }
      }
      lastEntry = entry
      if (entry.description) {
        descriptionByAttachmentId.set(String(id), entry.description)
        seenRefs.push(ref)
      }
    }
    for (const path of paths) {
      if (!isPathAllowed(path, config.allowedImageDirs)) throw new Error(`describe_image: path ${path} is outside the allowedImageDirs`);
      if (fs === undefined) throw new Error('describe_image: the fs service is unavailable in this deployment.')
      let bytes
      try {
        const target = await fs.resolve(path)
        bytes = await fs.readBytes(target, undefined, config.maxImageBytes)
      } catch (error) {
        const raw = error && error.message ? error.message : String(error)
        const msg = config.maskSecrets ? maskSecretsInError(raw) : raw
        throw new Error(`describe_image: failed to read ${path} (${msg})`)
      }
      const ref = await ctx.attachments.saveImage({
        data: bytes,
        mediaType: sniffMediaType(bytes) ?? 'image/png',
        name: path.split(/[\\/]/).pop(),
      })
      const entry = await callVisionModelWithBytes(bytes, ref.mediaType || 'image/png', question, { ...(exec ? { signal: exec.signal } : {}), detail })
      lastEntry = entry
      if (entry.description) {
        if (ref.attachmentId) descriptionByAttachmentId.set(String(ref.attachmentId), entry.description)
        seenRefs.push(ref)
      }
    }
    for (const url of urls) {
      // #202: policy applies to every redirect hop, not just the first URL.
      let res
      try {
        res = await safeFetch(url, {
          allowedHosts: config.allowedUrlHosts,
          init: { signal: AbortSignal.timeout(Math.max(1000, config.channelTimeoutMs || 15000)) },
        })
      } catch (e) {
        throw new Error(`describe_image: ${e && e.message ? e.message : e}`)
      }
      if (!res.ok) throw new Error(`describe_image: GET ${url} -> ${res.status}`)
      const declared = Number(res.headers.get('content-length') || 0)
      if (declared > config.maxImageBytes) throw new Error(`describe_image: GET ${url} body of ${declared} bytes exceeds the ${config.maxImageBytes} limit`)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > config.maxImageBytes) throw new Error(`describe_image: GET ${url} body exceeds the ${config.maxImageBytes} limit`)
      const contentType = res.headers.get('content-type') || sniffMediaType(bytes) || 'image/png'
      const entry = await callVisionModelWithBytes(bytes, contentType, question, { ...(exec ? { signal: exec.signal } : {}), detail })
      lastEntry = entry
      if (entry.description) seenRefs.push({ attachmentId: undefined, description: entry.description })
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

  

  // Block 0.3.9 (#66): read_image bridge — same channel driver, native-tool shape.
  // On text-only models the stock read_image tool is gated off by inputModalities;
  // this alias keeps the familiar name/shape so the model reads files through our
  // fallback chain instead of failing.
  

  // #95: inspect_image — accept attachmentId, local path, or http(s) URL and
  // describe it. Thin wrapper over the same describeImage resolution.
  

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

  

  

  

  

  

  // — Block 2 (0.2.7) OCR suite — 5 tools, LLM JSON, no sharp
  

  

  

  

  

  // Temporal diffing (#161) — compare two images, return list of differences.
  

  // Chain-of-thought visual reasoning (#154)
  

  // Self-check visual hypothesis (#156)



  // Screenshot to code (#165) — generate HTML/React/Tailwind from UI screenshot
  

  // Visual annotation overlay (#166) — draw bounding boxes with labels on image
  

  // QR/Barcode reader (#143)
  

  // LaTeX/Math formula extraction (#141)
  

  // — Block 0.4.0 (#70 #71 #72 #75): local OCR, structured evidence, VQA
  const tesseractAvailable = async () => isBinaryAvailable('tesseract')

  

  

  

  // Block 0.4.0 (#83 UI layout, #80 paste-translate)
  

  

  // — Block 3 (0.2.8) Pixel loop — pixel_diff / html_screenshot / materialize + focusHint/taskMode
  

  

  

  // — Block 10 (0.2.15) Video/page — 5 tools, stubs with upgrade notes
  

  

  



  // — Block 0.4.0 (#79 batch, #76 PDF pages)
  

  

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

  // #242: model-aware tool exposure. When the agent's chat route already has
  // native vision, the compensation tools are hidden from that agent through
  // the per-agent capability filter (`agent.ctx.tools.restrict`), which the
  // core uses for scoped tool masks; extra instruments stay visible. The mask
  // is swapped when the route changes and lifted when restrict is unavailable
  // (older cores keep the full list).
  const REDUNDANT_FOR_VISION = [
    'describe_image', 'read_image', 'inspect_image',
    'vision_vqa', 'vision_cot', 'vision_self_check', 'vision_describe_structured',
    'vision_ui_layout', 'vision_translate_image', 'vision_to_code', 'vision_ocr',
    'vision_audit_accessibility', 'vision_ui_flow', 'vision_math_extract',
    'vision_extract_formula', 'vision_extract_table', 'vision_extract_structured',
    'vision_scan_barcode', 'vision_qr_read', 'vision_trace', 'vision_colors',
    'vision_quality_check', 'vision_diff', 'vision_pixel_diff', 'vision_ground',
    'vision_detect', 'vision_crop', 'vision_annotate', 'vision_extract_foreground',
  ]
  let restrictUnavailable = false
  const agentToolPolicy = new WeakMap()
  const routeOf = (agent) => {
    try {
      const routed = agent && agent.session && typeof agent.session.requestHeader === 'function'
        ? agent.session.requestHeader()?.config
        : undefined
      return {
        provider: (routed && routed.provider) || (agent && agent.options && agent.options.provider),
        model: (routed && routed.model) || (agent && agent.options && agent.options.model),
      }
    } catch { return {} }
  }
  const liftAgentMask = (agent) => {
    const prev = agentToolPolicy.get(agent)
    if (prev && typeof prev.dispose === 'function') { try { prev.dispose() } catch {} }
    agentToolPolicy.delete(agent)
  }
  const applyAgentToolPolicy = async (agent, signal) => {
    if (restrictUnavailable || !agent) return
    // #242 review: switching the setting off, or losing the route, must restore
    // the full tool list instead of leaving a stale mask.
    if (config.hideRedundantTools === false) { liftAgentMask(agent); return }
    const { provider, model } = routeOf(agent)
    if (!provider || !model) { liftAgentMask(agent); return }
    // #244 review: the mask also depends on the bridge policy, so a runtime
    // nativePassthrough change must invalidate the per-route cache entry.
    const key = provider + '/' + model + '|' + (config.nativePassthrough || 'prefer')
    const prev = agentToolPolicy.get(agent)
    if (prev && prev.key === key) return
    let supportsImages = false
    try {
      supportsImages = acceptsImages(await ctx.llm.resolveModelInfo(provider, model, signal))
    } catch { supportsImages = false }
    if (prev && typeof prev.dispose === 'function') { try { prev.dispose() } catch {} }
    agentToolPolicy.delete(agent)
    // #242 follow-up: hide the compensation tools exactly when the bridge is
    // not going to run. nativePassthrough='never' forces bridging even for a
    // vision-capable model, so the tools stay available there.
    if (shouldBridgeForModel(config, supportsImages)) { agentToolPolicy.set(agent, { key, dispose: null }); return }
    try {
      const scoped = agent.ctx && (agent.ctx.tools || (typeof agent.ctx.get === 'function' ? agent.ctx.get('tools') : null))
      if (!scoped || typeof scoped.restrict !== 'function') {
        restrictUnavailable = true
        console.warn('[dsh-vision-bridge] per-agent tools.restrict() is unavailable; keeping the full tool list for vision models')
        return
      }
      const dispose = scoped.restrict({ deny: REDUNDANT_FOR_VISION })
      agentToolPolicy.set(agent, { key, dispose: typeof dispose === 'function' ? dispose : null })
    } catch (err) {
      restrictUnavailable = true
      console.warn('[dsh-vision-bridge] tools.restrict() failed; keeping the full tool list:', err && err.message)
    }
  }
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try { await applyAgentToolPolicy(payload && payload.agent, payload && payload.signal) } catch {}
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
    const settingsService = (sctx.get && typeof sctx.get === 'function' ? sctx.get('settings') : null) || sctx.settings
    if (!settingsService || typeof settingsService.register !== 'function') return
    const scope = settingsService.register(SETTINGS_NS, Config, { base: config })
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
              let stripEXIF = false, consensusEnabled = false
              let deskew = false, enhanceImage = false, selfCheckEnabled = true
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
                  if (typeof v.stripEXIF === 'boolean') stripEXIF = v.stripEXIF
                  if (typeof v.deskew === 'boolean') deskew = v.deskew
                  if (typeof v.enhanceImage === 'boolean') enhanceImage = v.enhanceImage
                  if (typeof v.selfCheckEnabled === 'boolean') selfCheckEnabled = v.selfCheckEnabled
                  if (typeof v.consensusEnabled === 'boolean') consensusEnabled = v.consensusEnabled
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
                channelOrderMode, maskPII, maskSystemPaths, stripEXIF, consensusEnabled,
                deskew, enhanceImage, selfCheckEnabled,
                imageMaxWidth, imageMaxHeight, imageQuality,
                channelFallback, channelTimeoutMs, channelCooldownMs,
                nativePassthrough, cacheEnabled, evidencePersist })
              return
            }
            if (req.method === 'POST') {
              if (!isTrustedSettingsRequest(req)) {
                writeJson(403, { error: 'forbidden: same-origin only' })
                return
              }
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
                  'channelOrderMode', 'maskPII', 'maskSystemPaths', 'stripEXIF',
                  'consensusEnabled', 'deskew',
                  'enhanceImage', 'selfCheckEnabled', 'imageMaxWidth',
                  'imageMaxHeight', 'imageQuality', 'allowedUrlHosts',
                  'nativePassthrough', 'cacheEnabled', 'cacheMaxEntries',
                  'evidencePersist', 'channelFallback', 'channelTimeoutMs', 'channelCooldownMs',
                  'taskMode', 'focusHint', 'detail', 'imageFormat', 'maskSecrets', 'auditLog',
                  'channelFailureMode', 'autoLocalOllama', 'autoFreeProviders'
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
              const sanitizedList = list.map((c) => {
                const copy = { ...c }
                if (copy.apiKey && typeof copy.apiKey === 'string' && copy.apiKey.trim()) {
                  copy.hasApiKey = true
                  copy.apiKey = maskApiKey(copy.apiKey)
                }
                return copy
              })
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
              writeJson(200, { channels: sanitizedList, probe })
              return
            }
            if (req.method === 'POST') {
              if (!isTrustedSettingsRequest(req)) {
                writeJson(403, { error: 'forbidden: same-origin only' })
                return
              }
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
                // #211: apiKeyRef is the NAME of a credential/env var, never a value.
                if (c.apiKeyRef !== undefined && c.apiKeyRef !== null && typeof c.apiKeyRef !== 'string') {
                  writeJson(400, { error: 'channels[' + i + ']: apiKeyRef must be a string (credential or env var name)' })
                  return
                }
              }
              const existingList = Array.isArray(config.channels) ? config.channels : []
              // #211: preserve unmasked keys by matching the channel identity
              // (channelKey), not the array position — reordering in the card
              // must not swap keys between channels.
              const existingByKey = new Map()
              for (const prev of existingList) {
                const k = channelKey(prev)
                if (!existingByKey.has(k)) existingByKey.set(k, prev)
              }
              const updated = incoming.map((c) => {
                const clean = { ...c }
                if (clean.apiKey && isMaskedKey(clean.apiKey)) {
                  const prev = existingByKey.get(channelKey(clean))
                  if (prev && prev.apiKey && !isMaskedKey(prev.apiKey)) {
                    clean.apiKey = prev.apiKey
                  }
                }
                return clean
              })
              config.channels = updated
              const returnedList = updated.map((c) => {
                const copy = { ...c }
                if (copy.apiKey && typeof copy.apiKey === 'string' && copy.apiKey.trim()) {
                  copy.hasApiKey = true
                  copy.apiKey = maskApiKey(copy.apiKey)
                }
                return copy
              })
              writeJson(200, { channels: returnedList })
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
        if (!isTrustedSettingsRequest(req)) {
          writeJson(403, { error: 'forbidden: same-origin only' })
          return
        }
        let pdfPath = null
        const frameFiles = []
        try {
          // #228: refuse oversized payloads before buffering them.
          const declared = Number(req.headers['content-length'] || 0)
          if (declared > config.maxPdfBytes) {
            writeJson(413, { error: 'payload of ' + declared + ' bytes exceeds the ' + config.maxPdfBytes + ' limit' })
            return
          }
          const chunks = []
          let total = 0
          let tooLarge = false
          for await (const chunk of req) {
            total += chunk.length
            if (total > config.maxPdfBytes) { tooLarge = true; break }
            chunks.push(chunk)
          }
          if (tooLarge) {
            writeJson(413, { error: 'payload exceeds the ' + config.maxPdfBytes + ' limit' })
            return
          }
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
                    const { tmpdir } = await import('node:os')
          const { join } = await import('node:path')
          const { writeFileSync, readFileSync, readdirSync, existsSync } = await import('node:fs')
          const dir = tmpdir()
          const stem = 'vbpdf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
          pdfPath = join(dir, stem + '.pdf')
          writeFileSync(pdfPath, pdfBytes)
          const r = await runProcessAsync('pdftoppm', ['-png', '-r', '150', '-l', '10', pdfPath, join(dir, stem)], { timeout: 60000 })
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
          if (!isTrustedSettingsRequest(req)) {
            writeJson(403, { error: 'forbidden: same-origin only' })
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
            // #201: wiping the audit trail is a mutating action — same-origin only.
            if (!isTrustedSettingsRequest(req)) { writeJson(403, { error: 'forbidden: same-origin only' }); return }
            // #203-review: with auditing off there is nothing on disk to clear,
            // and clearing would flush an empty file into existence.
            if (config.auditLog !== 'off') journal.clear()
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
          // #201: starting and cancelling batches spends vision calls — same-origin only.
          if (req.method === 'POST' && !isTrustedSettingsRequest(req)) { writeJson(403, { error: 'forbidden: same-origin only' }); return }
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
            // #201: clearing caches and the evidence store is mutating — same-origin only.
            if (!isTrustedSettingsRequest(req)) { writeJson(403, { error: 'forbidden: same-origin only' }); return }
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
          // #201: a bench run sends real requests to every channel — same-origin only.
          if (!isTrustedSettingsRequest(req)) { writeJson(403, { error: 'forbidden: same-origin only' }); return }
          const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
          // #211: bench the channels as they will actually run, with apiKeyRef resolved.
          const list = await liveChannels()
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
          // #201: probing every channel costs real calls and time, so the default
          // doctor report is static; pass ?probe=1 to run the end-to-end probes.
          const doProbe = new URL(req.url, 'http://localhost').searchParams.get('probe') === '1'
          // #201 review follow-up: a probe run costs real calls — same-origin
          // only. The static report stays readable cross-site.
          if (doProbe && !isTrustedSettingsRequest(req)) { writeJson(403, { error: 'forbidden: same-origin only' }); return }
          // #211: report on the channels as they will actually run, with apiKeyRef resolved.
          const list = await liveChannels()
          const report = []
          for (const ch of list) {
            const keyNames = (Array.isArray(config.keysFromEnv) ? config.keysFromEnv : []).filter((n) => typeof process.env[n] === 'string' && process.env[n].trim())
            const entry = {
              channel: channelKey(ch),
              type: ch.type,
              model: ch.model || '',
              hasInlineKey: typeof ch.apiKey === 'string' && ch.apiKey.trim().length > 0,
              apiKeyRef: ch.apiKeyRef || undefined,
              keysFromEnv: keyNames.map((n) => n + (n.length ? '' : '')),
              tier: ch.tier || 0,
            }
            if (doProbe) {
              // Probe end-to-end.
              const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
              const t0 = Date.now()
              const r = await runChannels([ch], {
                bytes: tinyPng, contentType: 'image/png', prompt: 'Reply with the single word OK.', timeoutMs: config.channelTimeoutMs, cooldownMs: 0, cooldowns: new Map(), fallback: 'sequential',
              })
              entry.probe = { ok: !!r.ok, latencyMs: Date.now() - t0, reason: r.ok ? undefined : r.reason }
            }
            report.push(entry)
          }
          const summary = {
            configured: list.length,
            reachable: doProbe ? report.filter((e) => e.probe && e.probe.ok).length : null,
            failed: doProbe ? report.filter((e) => e.probe && !e.probe.ok).map((e) => e.channel + ': ' + (e.probe.reason || '')) : [],
            probed: doProbe,
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
        // #202: policy applies to every redirect hop; oversized bodies refused.
        const res = await safeFetch(src, {
          allowedHosts: config.allowedUrlHosts,
          init: { signal: AbortSignal.timeout(Math.max(1000, config.channelTimeoutMs || 15000)) },
        });
        if (!res.ok) return null;
        const declared = Number(res.headers.get('content-length') || 0)
        if (declared > config.maxImageBytes) return null
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > config.maxImageBytes) return null
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
    // #200: the raw-fs fallback must respect the same privacy boundary as the
    // fs-service path — when allowedImageDirs is set, paths outside it are
    // refused here too instead of silently bypassing the sandbox.
    if (!isPathAllowed(src, config.allowedImageDirs)) return null;
    try {
      const { existsSync, readFileSync } = await import('node:fs');
      if (existsSync(src)) {
        const bytes = readFileSync(src);
        return { bytes, contentType: sniffMediaType(bytes) || 'image/png' };
      }
    } catch {}
    return null;
  }

  
  // #163: UI Flow & User Journey Reconstructor
  

  // #155: Multi-Model Consensus Tool. #203: consensusEnabled existed in the
  // settings but was never consulted — it gates the tool now.
  

  // #171: Persistent Visual Memory Search
  

  // #141: LaTeX & Math Formula Extractor
  

  // #142: Complex Table Extractor
  

  // #143: QR & Barcode Scanner
  

  // #144: Structured JSON Schema Extractor
  

  // #167: WCAG Accessibility Auditor
  

  
  // ── Cross-Plugin Optional Synergy Hooks ─────────────────────────────────
  // Safe, optional integrations: zero dependencies, 100% autonomous if companion plugins are absent.

  // Cross-plugin synergy tool: verify AI generated images (#dsh-image-gen synergy)
  

  // Export visual report (#174) — generate formatted Markdown/PDF report
  

  // #206: tool registrations moved to lib/tools/* domain files. The deps
  // object carries the apply()-closure state that tools previously captured
  // directly. Registration order is preserved per domain.
  const toolsDeps = { ctx, config, attachmentById, descriptionByAttachmentId, descriptionByHash, batches, startBatch, callVisionModelWithBytes, visionSelection, resolveImageBytes, resolveSourceBytes, collectText, describeImage, effectivePrompt, liveChannels, groundingPrompt, parseBbox, tesseractAvailable }
  registerCoreTools(toolsDeps)
  registerGroundingTools(toolsDeps)
  registerOcrTools(toolsDeps)
  registerDocumentTools(toolsDeps)
  registerAnalysisTools(toolsDeps)
  registerMediaTools(toolsDeps)

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
