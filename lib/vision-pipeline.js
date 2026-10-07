import {
  acceptsImages,
  bestEffort,
  pHash,
  checkImageQuality,
  collectText,
  compressImage,
  contentHash,
  deskewImage,
  enhanceImage,
  extractSessionId,
  imageDimensions,
  isPathAllowed,
  isSafeFetchUrl,
  maskPII,
  maskSecretsInError,
  maskSystemPaths,
  resolveInside,
  runLocalOCR,
  safeFetch,
  scaleBbox,
  sniffMediaType,
  stripEXIF,
  VISION_PASS,
} from './vision-core.js'
import { runChannels, getSortedChannels, channelKey } from './channels.js'
import { smartOptimizeImage } from './image-processing.js'
import { descriptionCacheKey } from './cache.js'


export function createVisionPipeline(deps) {
  const {
    ctx,
    config,
    getLiveConfig,
    liveChannels,
    logger,
    attachmentById,
    descriptionByAttachmentId,
    descriptionByHash,
    recordAttachment,
    recordDescription,
    journalAdd,
    evidenceStore,
    trackRequest,
    getLastUserText,
    bumpUsage,
    channelCooldowns,
    channelCircuitStates,
    channelLatencies,
    storageDir,
    requireScope,
  } = deps

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



  const cacheKeyFor = (bytes, question, model) => {
    if (!descriptionByHash) return null
    return descriptionCacheKey({
      bytes,
      prompt: question,
      model,
      mode: config.describeStrategy || 'auto',
    })
  }
  const pHashKeyFor = (ph, question, model) => {
    if (!descriptionByHash || !ph) return null
    return 'ph:' + ph + '\u0001' + [
      String(question || ''),
      String(model || ''),
      String(config.describeStrategy || 'auto'),
      '1',
    ].join('\u0001')
  }


  const resolveChannelForProvider = async (provider, model) => {
    try {
      const cfgProviders = typeof ctx.llm.listConfigurableProviders === 'function' ? ctx.llm.listConfigurableProviders() : []
      const found = (cfgProviders || []).find((p) => p && (p.provider || p.id) === provider)
      if (found && found.baseURL) {
        let apiKey = ''
        let credError = null
        if (found.apiKeyEnv) {
          try {
            const creds = ctx.get('credentials')
            if (creds && typeof creds.resolve === 'function') {
              apiKey = await creds.resolve(found.apiKeyEnv)
            } else if (!creds) {
              credError = 'credentials service not available in context'
            }
          } catch (err) {
            credError = `credentials service error: ${err?.message || err}`
            logger.debug('[dsh-vision-bridge] resolveChannelForProvider:', credError)
          }
          if (!apiKey && process.env[found.apiKeyEnv]) {
            apiKey = process.env[found.apiKeyEnv]
          }
          if (!apiKey && !credError) {
            credError = `credential ${found.apiKeyEnv} not found`
          }
        }
        return {
          type: 'openai-compatible',
          baseURL: found.baseURL,
          model,
          apiKey: apiKey || '',
          ...(credError ? { credError } : {}),
        }
      }
    } catch (err) {
      logger.debug('[dsh-vision-bridge] resolveChannelForProvider failed:', err?.message || err)
    }
    return null
  }



  const callVisionModelWithBytes = async (bytes, contentType, question, opts) => {
    // #203: maskPII now actually gates — PII is masked out of the prompt
    // before it reaches the vision model, the cache or the journal.
    if (config.maskPII && typeof question === 'string' && question) question = maskPII(question)
    // Image preprocessing pipeline (#145 #146 #147). #203-review: runs
    // regardless of the pixel guard — maxImagePixels=0 must not silently
    // disable deskew/enhance/stripEXIF/compress.
    const preprocessWarnings = []
    try {
      const opt = await smartOptimizeImage(bytes, contentType, {
        maxWidth: config.imageMaxWidth || 1920,
        maxHeight: config.imageMaxHeight || 1080,
        quality: config.imageQuality || 80,
        format: config.imageFormat || 'auto',
        stripExifFlag: !!config.stripEXIF,
        deskewFlag: !!config.deskew,
        enhanceFlag: !!config.enhanceImage,
      })
      if (opt && opt.bytes) {
        bytes = opt.bytes
        contentType = opt.contentType || contentType
      }
      if (opt && Array.isArray(opt.warnings) && opt.warnings.length) {
        preprocessWarnings.push(...opt.warnings)
      }
    } catch (err) {
      preprocessWarnings.push(`smartOptimizeImage failed: ${err?.message || err}`)
      logger.debug('[dsh-vision-bridge] smartOptimizeImage fallback:', err?.message || err)
    }

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
      const key = cacheKeyFor(bytes, question, modelHint)
      const skipCache = Boolean(opts && opts.noCache)
      // #170, #377, #378: pHash cache with task identity and null safety
      const ph = (!skipCache && descriptionByHash) ? await pHash(bytes) : null
      const phKey = ph ? pHashKeyFor(ph, question, modelHint) : null
      if (!skipCache) {
        if (phKey && descriptionByHash && descriptionByHash.has(phKey)) {
          const cached = descriptionByHash.get(phKey)
          trackRequest({ ok: true, cached: true, pHash: ph, channel: 'phash-cache' })
          return { ok: true, description: cached, cached: true, warnings: preprocessWarnings }
        }
        if (key && descriptionByHash) {
          const cached = descriptionByHash.get(key)
          if (typeof cached === 'string' && cached.trim()) return { ok: true, description: cached, cached: true, warnings: preprocessWarnings }
          // Block 4: persistent evidence fallback (survives restarts).
          const persisted = evidenceStore && evidenceStore.get(key)
          if (typeof persisted === 'string' && persisted.trim()) {
            descriptionByHash.set(key, persisted)
            return { ok: true, description: persisted, cached: true, warnings: preprocessWarnings }
          }
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
        circuitStates: channelCircuitStates,
        latencies: channelLatencies,
        fallback: config.channelFallback || 'sequential',
        detail,
        stream: config.stream === true,
        keysFromEnv: Array.isArray(config.keysFromEnv) ? config.keysFromEnv : undefined,
        llm: ctx.llm,
        attachments: ctx.attachments,
        visionSelection,
        collectText,
      })
      const chKey = result.channel ? channelKey(result.channel) : 'all'
      // #98: surface which key/quota the read spent.
      const keyLabel = result.keyUsed
      if (result.ok && result.description) {
        let desc = result.description
        if (config.maskSystemPaths) desc = maskSystemPaths(desc)
        bumpUsage(chKey, Date.now() - t0, true, result.keyUsed, result.usage)
        if (key && descriptionByHash) descriptionByHash.set(key, desc)
        if (key && evidenceStore) evidenceStore.set(key, desc)
        if (phKey && descriptionByHash) descriptionByHash.set(phKey, desc)
        trackRequest({ ok: true, cached: false, pHash: ph, channel: chKey })
        // #108: journal the successful call.
        journalAdd({ ok: true, channel: chKey, key: keyLabel, imageHash: contentHash(bytes), prompt: question.slice(0, 200), tokensIn: result.usage && result.usage.prompt_tokens, tokensOut: result.usage && result.usage.completion_tokens, latencyMs: Date.now() - t0 })
        // #88: expose meta.attempts (channel-level failover trace) to callers/UI.
        return { ok: true, description: desc, cached: false, attempts: result.attempts, keyUsed: keyLabel, usage: result.usage, warnings: preprocessWarnings }
      }
      bumpUsage(chKey, Date.now() - t0, false)
      // #108: journal the failure.
      journalAdd({ ok: false, channel: chKey, key: keyLabel, imageHash: contentHash(bytes), prompt: question.slice(0, 200), reason: result.reason, latencyMs: Date.now() - t0 })
      if (config.channelFailureMode === 'placeholder') {
        return { ok: false, error: result.reason || 'all channels failed', description: '[image description unavailable: ' + (result.reason || 'all channels failed') + ']', cached: false, attempts: result.attempts, keyUsed: keyLabel }
      }
      throw new Error('dsh-vision-bridge: ' + (result.reason || 'all channels failed'))
    }
    const { provider, model } = await visionSelection()
    const key = cacheKeyFor(bytes, question, provider + '/' + model)
    if (key && descriptionByHash) {
      const cached = descriptionByHash.get(key)
      if (typeof cached === 'string' && cached.trim()) return { description: cached, provider, model, cached: true, warnings: preprocessWarnings }
      const persisted = evidenceStore && evidenceStore.get(key)
      if (typeof persisted === 'string' && persisted.trim()) {
        descriptionByHash.set(key, persisted)
        return { description: persisted, provider, model, cached: true, warnings: preprocessWarnings }
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
          cooldowns: channelCooldowns,
          circuitStates: channelCircuitStates,
          latencies: channelLatencies,
          llm: ctx.llm,
          attachments: ctx.attachments,
          visionSelection,
          collectText,
        })
        if (res && res.ok && res.description) {
          let desc = res.description
          if (config.maskSystemPaths) desc = maskSystemPaths(desc)
          if (key && descriptionByHash) descriptionByHash.set(key, desc)
          if (key && evidenceStore) evidenceStore.set(key, desc)
          return { description: desc, provider, model, cached: false, warnings: preprocessWarnings }
        }
      } catch (err) {
        logger.warn('[dsh-vision-bridge] directChannel run failed, falling back to ctx.llm.stream:', err)
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
    if (text && key && descriptionByHash) {
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
    const currentText = typeof getLastUserText === 'function' ? getLastUserText() : ''
    const hint = currentText && config.focusHint !== false ? String(currentText).trim() : ''
    if (hint) prompt += ` Focus on what is relevant to this user request: "${hint.slice(0, 400)}"`
    let firstPass
    if (config.describeStrategy === 'ocr-local') {
      const ocrText = await runLocalOCR(stored.data, ref.mediaType || 'image/png', config?.ocrLang || 'eng')
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
        logger.warn('[dsh-vision-bridge] LLM vision call failed, trying local OCR fallback:', err)
      }

      // Offline OCR & metadata fallback if LLM produces no description
      if (!firstPass || !firstPass.trim()) {
        try {
          const ocrText = await runLocalOCR(stored.data, ref.mediaType || 'image/png', config?.ocrLang || 'eng')
          const dims = imageDimensions(stored.data)
          const parts = []
          if (dims && dims.width > 0 && dims.height > 0) parts.push(`Image dimensions: ${dims.width}×${dims.height}px (${(stored.data.length / 1024).toFixed(1)} KB)`)
          if (ocrText && ocrText.trim()) parts.push(`Extracted text:\n${ocrText.trim()}`)
          if (parts.length > 0) firstPass = parts.join('\n\n')
        } catch (err) { logger.debug('[dsh-vision-bridge] firstPass OCR fallback:', err?.message || err) }
      }
    }
    // ponytail: escalation kept inline — second pass only when auto-escalate is on
    // and the first pass self-reports complexity=complex. Upgrade path: proper
    // complexity classifier once we have a tracked metric.
    if (config.escalation !== 'auto-escalate' || !firstPass) {
      if (firstPass && id !== undefined) recordDescription(id, firstPass)
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
    if (description && id !== undefined) recordDescription(id, description)
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
    const sessionId = extractSessionId(exec)
    const attachmentIds = Array.isArray(args.attachmentIds) ? [...args.attachmentIds] : (args.attachmentId ? [String(args.attachmentId)] : [])
    const paths = Array.isArray(args.paths) ? [...args.paths] : (args.path ? [String(args.path)] : [])
    const urls = Array.isArray(args.urls) ? [...args.urls] : (args.url ? [String(args.url)] : [])
    const detail = args.detail
    const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : 'Describe this image.'

    // Auto-fallback: if no attachment/path specified, use the most recent attachment from the chat
    if (attachmentIds.length + paths.length + urls.length === 0) {
      const lastRef = attachmentById.getLast(sessionId)
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
      const ref = attachmentById.get(String(id), sessionId)
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
      // Block 5 (#387): route all attachment questions through unified callVisionModelWithBytes pipeline
      const entry = await callVisionModelWithBytes(
        stored.data,
        ref.mediaType || 'image/png',
        question,
        { ...(exec ? { signal: exec.signal } : {}), detail }
      )
      lastEntry = entry
      if (entry.description) {
        recordDescription(id, entry.description)
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
        if (ref.attachmentId) recordDescription(ref.attachmentId, entry.description)
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


  return {
    visionSelection,
    cacheKeyFor,
    pHashKeyFor,
    resolveChannelForProvider,
    callVisionModelWithBytes,
    describeAttachment,
    classifyComplexity,
    describeImage,
  }
}
