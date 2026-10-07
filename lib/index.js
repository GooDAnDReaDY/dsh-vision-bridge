// Default prompt used across vision tools: 'Describe this image.'
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

import { readFileSync } from 'node:fs'
import { getLogger, setPluginLogger } from './logger.js'
import { registerPluginUpdater } from './updater.js'
import {
  registerCoreTools,
  registerGroundingTools,
  registerOcrTools,
  registerDocumentTools,
  registerAnalysisTools,
  registerMediaTools,
  registerAttachTools,
} from './tools/index.js'
import { createLru } from './cache.js'
import { isBinaryAvailable } from './process.js'
import {
  Config,
  FREE_VISION_PROVIDERS,
  MAX_BATCH_BODY_BYTES,
  MAX_CONFIG_BODY_BYTES,
  SessionScopedAttachmentMap,
  VISION_PASS,
  acceptsImages,
  bestEffort,
  bits64ToHex,
  blocksHaveImage,
  checkImageQuality,
  collectText,
  compressImage,
  contentHash,
  deriveKeyLabel,
  deskewImage,
  enhanceImage,
  extractSessionId,
    imageDimensions,
  inject,
  isLoopbackAddress,
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
    plainConfig,
  readBoundedBody,
  resolveChannelApiKey,
  resolveInside,
  rewriteImagesDeep,
  runLocalOCR,
  safeFetch,
  sanitizeAllowed,
  scaleBbox,
  shouldBridgeForModel,
  sniffMediaType,
  stripEXIF,
  wrapConfig,
} from './vision-core.js'
import { smartOptimizeImage, normalizeBbox } from './image-processing.js'
import { probeStorage, resolveStorageDir } from './storage.js'
import { setupAgentBoundary, REDUNDANT_FOR_VISION, ATTACH_ONLY_TOOLS } from './agent-boundary.js'
import { setupPluginRoutes } from './routes-deps.js'
import { setupProviderDiscovery } from './provider-discovery.js'
import { createImageResolver } from './image-resolution.js'
import { setupJournalAndEvidence } from './journal-evidence.js'
import { createVisionPipeline } from './vision-pipeline.js'

// #285: plugin version from package.json, read once at module load so /doctor
// can report it without touching the filesystem on every request.
const PLUGIN_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

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
  resolveInside,
  extractSessionId,
  SessionScopedAttachmentMap,
  isPrivateIp,
  isSafeFetchUrl,
  isTrustedSettingsRequest,
  isLoopbackAddress,
  deriveKeyLabel,
  readBoundedBody,
  MAX_CONFIG_BODY_BYTES,
  MAX_BATCH_BODY_BYTES,
  maskApiKey,
  maskPII,
  maskSecretsInError,
  maskSystemPaths,
  name,
  pHash,
  plainConfig,
  wrapConfig,
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
export { smartOptimizeImage } from './image-processing.js'
export { probeStorage, resolveStorageDir } from './storage.js'
export { REDUNDANT_FOR_VISION, ATTACH_ONLY_TOOLS } from './agent-boundary.js'

export function apply(ctx, rawConfig) {
  const logger = getLogger(ctx, 'vision-bridge')
  setPluginLogger(logger)
  const config = wrapConfig(rawConfig)

  const SETTINGS_NS = 'dsh-vision-bridge'
  let settingsSvc = null
  let legacyScope = null
  let inMemoryConfig = { ...plainConfig(config) }

  const describeRow = () => {
    if (typeof settingsSvc?.describe !== 'function') return null
    try {
      const res = settingsSvc.describe()
      if (Array.isArray(res)) {
        const found = res.find((r) => r && r.ns === SETTINGS_NS)
        if (found) return found
      } else if (res && typeof res === 'object' && res.ns === SETTINGS_NS) {
        return res
      }
      const direct = settingsSvc.describe(SETTINGS_NS)
      if (direct && typeof direct === 'object') return direct
      return null
    } catch (err) {
      /* settings service describe probe failed */
      void err
      return null
    }
  }

  const persistSettings = async (patch) => {
    const plainPatch = plainConfig(patch)
    inMemoryConfig = { ...inMemoryConfig, ...plainPatch }
    for (const [k, v] of Object.entries(plainPatch)) {
      try {
        config[k] = v
        if (rawConfig && typeof rawConfig === 'object') {
          rawConfig[k] = v
        }
      } catch (err) {
        /* ignore non-writable properties */
        void err
      }
    }
    if (settingsSvc) {
      const row = describeRow()
      const rev = row?.revision
      if (typeof settingsSvc.update === 'function') {
        await settingsSvc.update(SETTINGS_NS, structuredClone(inMemoryConfig), rev)
      } else if (typeof settingsSvc.replace === 'function') {
        await settingsSvc.replace(SETTINGS_NS, structuredClone(inMemoryConfig), rev)
      }
    }
    if (legacyScope && typeof legacyScope.update === 'function') {
      try {
        legacyScope.update(plainPatch)
      } catch (err) {
        /* best-effort legacy scope sync */
        void err
      }
    }
  }

  const settingsScope = {
    getSnapshot: () => {
      const row = describeRow()
      if (row && row.value && typeof row.value === 'object') {
        return { value: { ...plainConfig(row.value), ...inMemoryConfig } }
      }
      if (legacyScope && typeof legacyScope.get === 'function') {
        try {
          const leg = legacyScope.get()
          if (leg && typeof leg === 'object') {
            return { value: { ...plainConfig(leg), ...inMemoryConfig } }
          }
        } catch (err) {
          /* best-effort legacy get */
          void err
        }
      }
      return { value: inMemoryConfig }
    },
    set: async (key, value) => {
      await persistSettings({ [key]: value })
    },
    unset: async (key) => {
      await persistSettings({ [key]: '' })
    },
    update: async (patch) => {
      await persistSettings(patch)
    },
    replace: async (next) => {
      await persistSettings(next)
    },
  }

  const requireScope = () => settingsScope

  const getLiveConfig = () => {
    return bestEffort('snapshot.read', () => {
      const scope = requireScope()
      const snap = scope.getSnapshot()
      if (snap && snap.value) return { ...config, ...snap.value }
      return config
    }, config)
  }

  ctx.inject(['settings'], (sctx) => {
    try {
      settingsSvc = (sctx.get && typeof sctx.get === 'function' ? sctx.get('settings') : null) || sctx.settings || null
      if (!settingsSvc) return
      const row = describeRow()
      if (row && row.value && typeof row.value === 'object') {
        const plain = plainConfig(row.value)
        inMemoryConfig = { ...inMemoryConfig, ...plain }
        for (const [k, v] of Object.entries(plain)) {
          try {
            config[k] = v
            if (rawConfig && typeof rawConfig === 'object') rawConfig[k] = v
          } catch (err) {
            /* ignore non-writable properties */
            void err
          }
        }
      }
      if (typeof settingsSvc.register === 'function') {
        legacyScope = settingsSvc.register(SETTINGS_NS, Config, { base: config })
      }
      if (typeof sctx.effect === 'function') {
        sctx.effect(() => () => {
          settingsSvc = null
          legacyScope = null
        })
      }
    } catch (err) {
      /* optional settings service probe */
      void err
    }
  })

  if (typeof ctx.on === 'function') {
    const onSettingsChanged = (doc) => {
      if (doc && doc.ns === SETTINGS_NS && doc.value && typeof doc.value === 'object') {
        const plain = plainConfig(doc.value)
        inMemoryConfig = { ...inMemoryConfig, ...plain }
        for (const [k, v] of Object.entries(plain)) {
          try {
            config[k] = v
            if (rawConfig && typeof rawConfig === 'object') rawConfig[k] = v
          } catch (err) {
            /* ignore non-writable properties */
            void err
          }
        }
      }
    }
    ctx.on('settings/document-updated', onSettingsChanged)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (typeof ctx.off === 'function') ctx.off('settings/document-updated', onSettingsChanged)
      })
    }
  }

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


  // #203-review: single choke point for prompt masking on every direct
  // llm.stream path that bypasses callVisionModelWithBytes.
  const effectivePrompt = (t) => (config.maskPII && typeof t === 'string' && t ? maskPII(t) : t)
  // #211: channels with apiKeyRef resolve their key at call time via the
  // credential service, falling back to the named environment variable, so
  // plaintext keys are no longer required in settings.
  const liveChannels = async () => {
    const live = getLiveConfig()
    const list = Array.isArray(live.channels) ? live.channels : (Array.isArray(config.channels) ? config.channels : [])
    let creds = null
    // intentional optional dependency probe: credentials service may not be registered
    try { creds = ctx.get('credentials') } catch (err) { /* optional credentials probe */ void err }
    const resolveCred = creds && typeof creds.resolve === 'function' ? (n) => creds.resolve(n) : null
    const allowedEnv = Array.isArray(live.keysFromEnv) ? live.keysFromEnv : (Array.isArray(config.keysFromEnv) ? config.keysFromEnv : null)
    const out = []
    for (const c of list) out.push(await resolveChannelApiKey(c, resolveCred, process.env, allowedEnv))
    return out
  }
  // attachmentId -> full ref, recorded from image blocks seen at the agent
  // boundary with per-session scoping and isolation (#379).
  const attachmentById = new SessionScopedAttachmentMap()
  function recordAttachment(id, ref, sessionId = 'global') {
    if (id === undefined || id === null || !ref) return
    const key = String(id)
    attachmentById.set(key, ref, sessionId)
    while (attachmentById.size > 300) {
      const oldest = attachmentById.keys().next().value
      if (oldest !== undefined) attachmentById.delete(oldest, sessionId)
      else break
    }
  }
  // Channel cooldowns persist across calls within the plugin lifetime.
  const channelCooldowns = new Map()
  // Circuit breaker states per channel (#129).
  const channelCircuitStates = new Map()
  // Latency tracking per channel (#127).
  const channelLatencies = new Map()
  // Block 0.3.9 (#65): last user text, scoped by session for focus hint (#379).
  let lastUserText = ''
  const lastUserTextBySession = new Map()
  function setLastUserText(sessionId, txt) {
    const sId = String(sessionId || 'global')
    lastUserTextBySession.set(sId, txt)
    if (lastUserTextBySession.size > 100) {
      const oldest = lastUserTextBySession.keys().next().value
      if (oldest !== undefined) lastUserTextBySession.delete(oldest)
    }
    lastUserText = txt
  }
  function getLastUserText(sessionId = 'global') {
    const sId = String(sessionId || 'global')
    if (sId !== 'global' && lastUserTextBySession.has(sId)) {
      return lastUserTextBySession.get(sId) || ''
    }
    return lastUserText || ''
  }
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


  // contentHash -> description, so repeated questions about the same image
  // reuse a cached answer instead of re-spending a vision-model call.

  // contentHash -> description, so repeated questions about the same image
  // reuse a cached answer instead of re-spending a vision-model call.
  const descriptionByHash = config.cacheEnabled === false ? null : createLru(config.cacheMaxEntries)

  const storageDir = resolveStorageDir(ctx, config)
  const {
    evidenceStore,
    journal,
    journalAdd,
    batches,
    startBatch,
    lastRequests,
    trackRequest,
  } = setupJournalAndEvidence(ctx, config, storageDir)

  // attachmentId -> description, for inline substitution in later text turns.
  const descriptionByAttachmentId = new Map()
  function recordDescription(id, desc) {
    if (id === undefined || id === null || !desc) return
    const key = String(id)
    descriptionByAttachmentId.delete(key)
    descriptionByAttachmentId.set(key, desc)
    if (descriptionByAttachmentId.size > 300) {
      const oldest = descriptionByAttachmentId.keys().next().value
      if (oldest !== undefined) descriptionByAttachmentId.delete(oldest)
    }
  }

  const { resolveImageBytes, resolveSourceBytes } = createImageResolver({ ctx, config, attachmentById, logger })

  const {
    visionSelection,
    cacheKeyFor,
    pHashKeyFor,
    resolveChannelForProvider,
    callVisionModelWithBytes,
    describeAttachment,
    classifyComplexity,
    describeImage,
  } = createVisionPipeline({
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
  })

  setupProviderDiscovery(ctx, config)

  setupAgentBoundary(ctx, {
    config,
    descriptionByAttachmentId,
    recordAttachment,
    describeAttachment,
    setLastUserText,
    logger,
  })

  const routesDeps = {
    config,
    requireScope,
    liveChannels,
    callVisionModelWithBytes,
    channelCircuitStates,
    usageByChannel,
    lastRequests,
    journal,
    evidenceStore,
    batches,
    attachmentById,
    resolveImageBytes,
    startBatch: (items, prompt) => startBatch(items, prompt, callVisionModelWithBytes),
    descriptionByHash,
    descriptionByAttachmentId,
    recordAttachment,
    pluginVersion: PLUGIN_VERSION,
    probeStorage,
  }
  setupPluginRoutes(ctx, routesDeps)

  ctx.effect(
    () =>
      registerPluginUpdater(ctx, {
        endpoint: '/api/dsh-vision-bridge/update',
        packageName: '@goodandready/dsh-vision-bridge',
        manifestUrl: new URL('../package.json', import.meta.url),
      }),
    'dsh-vision-bridge: plugin updater route',
  )

  const groundingPrompt = (target) => `Locate "${target}" in this image. Reply with strict JSON {"bbox":[x1,y1,x2,y2]} in 0-1000 coords only. If not found, {"bbox":null}.`
  const parseBbox = (text) => bestEffort('parseBbox', () => { const j = JSON.parse(text.match(/\{[\s\S]*\}/)?. [0] || ''); if (Array.isArray(j.bbox) && j.bbox.length === 4) return j.bbox.map((n) => Math.max(0, Math.min(1000, Number(n) || 0))); return null; }, null)
  const tesseractAvailable = async () => isBinaryAvailable('tesseract')

  const toolsDeps = {
    ctx,
    config,
    attachmentById,
    descriptionByAttachmentId,
    descriptionByHash,
    batches,
    startBatch: (items, prompt) => startBatch(items, prompt, callVisionModelWithBytes),
    callVisionModelWithBytes,
    visionSelection,
    resolveImageBytes,
    resolveSourceBytes,
    collectText,
    describeImage,
    effectivePrompt,
    liveChannels,
    groundingPrompt,
    parseBbox,
    tesseractAvailable,
    recordAttachment,
    extractSessionId,
  }

  registerCoreTools(toolsDeps)
  registerGroundingTools(toolsDeps)
  registerOcrTools(toolsDeps)
  registerDocumentTools(toolsDeps)
  registerAnalysisTools(toolsDeps)
  registerMediaTools(toolsDeps)
  registerAttachTools(toolsDeps)
}
