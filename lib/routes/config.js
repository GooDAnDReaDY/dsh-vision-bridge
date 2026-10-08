import { bestEffort, Config, plainConfig } from '../vision-core.js'
// #291: config & provider domain routes
import { acceptsImages, isTrustedSettingsRequest, maskApiKey, isMaskedKey, FREE_VISION_PROVIDERS, readBoundedBody, MAX_CONFIG_BODY_BYTES } from '../vision-core.js'
import { channelKey } from '../channels.js'

const CHANNEL_TYPES = new Set(['dsh-catalog', 'openai-compatible', 'ollama', 'custom', 'webhook', 'vllm', 'sglang'])

export function registerConfigRoutes(ctx, deps) {
  const { config, requireScope, liveChannels } = deps

  // GET /dsh-vision-bridge/models
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
            if (!isTrustedSettingsRequest(req)) {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'forbidden: same-origin only' }))
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

  // GET & POST /dsh-vision-bridge/config
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
          try {
            if (req.method === 'GET') {
              if (!isTrustedSettingsRequest(req)) {
                writeJson(403, { error: 'forbidden: same-origin only' })
                return
              }
              let snapshotValue = {}
              try {
                const scope = requireScope()
                const snapshot = scope.getSnapshot()
                if (snapshot && snapshot.value) {
                  snapshotValue = snapshot.value
                }
              } catch (err) {
                /* settings scope probe fallback */
                void err
              }
              const merged = plainConfig(Config({ ...config, ...snapshotValue }))
              writeJson(200, {
                provider: String(merged.visionProvider || ''),
                model: String(merged.visionModel || ''),
                mode: merged.mode,
                describeStrategy: merged.describeStrategy,
                escalation: merged.escalation,
                channelOrderMode: merged.channelOrderMode,
                maskPII: merged.maskPII,
                maskSystemPaths: merged.maskSystemPaths,
                stripEXIF: merged.stripEXIF,
                consensusEnabled: merged.consensusEnabled,
                deskew: merged.deskew,
                enhanceImage: merged.enhanceImage,
                selfCheckEnabled: merged.selfCheckEnabled,
                imageMaxWidth: merged.imageMaxWidth,
                imageMaxHeight: merged.imageMaxHeight,
                imageQuality: merged.imageQuality,
                attachMaxItems: merged.attachMaxItems,
                hideRedundantTools: merged.hideRedundantTools,
                channelFallback: merged.channelFallback,
                channelTimeoutMs: merged.channelTimeoutMs,
                channelCooldownMs: merged.channelCooldownMs,
                nativePassthrough: merged.nativePassthrough,
                cacheEnabled: merged.cacheEnabled,
                evidencePersist: merged.evidencePersist,
              })
              return
            }
            if (req.method === 'POST') {
              if (!isTrustedSettingsRequest(req)) {
                writeJson(403, { error: 'forbidden: same-origin only' })
                return
              }
              let raw = ''
              try {
                raw = await readBoundedBody(req, MAX_CONFIG_BODY_BYTES)
              } catch (err) {
                if (err && err.statusCode === 413) {
                  writeJson(413, { error: err.message })
                  return
                }
                writeJson(400, { error: 'failed to read request body' })
                return
              }
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
              const NUMERIC_RANGES = {
                imageMaxWidth: [64, 10000],
                imageMaxHeight: [64, 10000],
                imageQuality: [1, 100],
                cacheMaxEntries: [1, 100000],
                timeoutMs: [1000, 600000],
                channelTimeoutMs: [1000, 600000],
                channelCooldownMs: [0, 600000],
              }
              for (const [field, [lo, hi]] of Object.entries(NUMERIC_RANGES)) {
                if (!Object.prototype.hasOwnProperty.call(body, field)) continue
                const v = body[field]
                if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
                  writeJson(400, { error: field + ' must be an integer between ' + lo + ' and ' + hi }); return
                }
              }
              if (Object.prototype.hasOwnProperty.call(body, 'attachMaxItems')) {
                const n = body.attachMaxItems
                if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 32) {
                  writeJson(400, { error: 'attachMaxItems must be a whole number between 1 and 32' }); return
                }
              }
              if (Object.prototype.hasOwnProperty.call(body, 'hideRedundantTools')
                && typeof body.hideRedundantTools !== 'boolean') {
                writeJson(400, { error: 'hideRedundantTools must be a boolean' }); return
              }
              try {
                const scope = requireScope()
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
                  'channels',
                  'channelOrderMode', 'maskPII', 'maskSystemPaths', 'stripEXIF',
                  'consensusEnabled', 'deskew',
                  'enhanceImage', 'selfCheckEnabled', 'imageMaxWidth',
                  'imageMaxHeight', 'imageQuality', 'attachMaxItems',
                  'hideRedundantTools', 'allowedUrlHosts',
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
                let outProvider = provider, outModel = model
                let curVal = {}
                curVal = bestEffort('routes.config.snapshotRead', () => {
                  const cur = scope.getSnapshot()
                  if (cur && cur.value) {
                    if (!Object.prototype.hasOwnProperty.call(body, 'provider')) outProvider = String(cur.value.visionProvider || '')
                    if (!Object.prototype.hasOwnProperty.call(body, 'model')) outModel = String(cur.value.visionModel || '')
                    return cur.value
                  }
                  return {}
                }, {}) || {}
                const persisted = Boolean(scope.hasPersistence ? scope.hasPersistence() : true)
                writeJson(200, {
                  provider: outProvider,
                  model: outModel,
                  mode: incomingMode || curVal.mode || 'hybrid',
                  describeStrategy: incomingStrategy || curVal.describeStrategy || 'auto',
                  escalation: incomingEscalation || curVal.escalation || 'simple-only',
                  persisted,
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

  // GET & POST /dsh-vision-bridge/channels
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
          try {
            if (req.method === 'GET') {
              if (!isTrustedSettingsRequest(req)) {
                writeJson(403, { error: 'forbidden: same-origin only' })
                return
              }
              const list = await liveChannels()
              const returnedList = list.map((c) => {
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
            if (req.method === 'POST') {
              if (!isTrustedSettingsRequest(req)) {
                writeJson(403, { error: 'forbidden: same-origin only' })
                return
              }
              let raw = ''
              try {
                raw = await readBoundedBody(req, MAX_CONFIG_BODY_BYTES)
              } catch (err) {
                if (err && err.statusCode === 413) {
                  writeJson(413, { error: err.message })
                  return
                }
                writeJson(400, { error: 'failed to read request body' })
                return
              }
              let body
              try { body = JSON.parse(raw) } catch { body = {} }
              if (!Array.isArray(body && body.channels)) {
                writeJson(400, { error: 'channels array required' })
                return
              }
              const incoming = body.channels
              for (let i = 0; i < incoming.length; i++) {
                const c = incoming[i]
                if (!c || typeof c !== 'object') {
                  writeJson(400, { error: 'channel ' + i + ' must be an object' })
                  return
                }
                if (!CHANNEL_TYPES.has(c.type)) {
                  writeJson(400, { error: 'channel ' + i + ' unknown type: ' + c.type })
                  return
                }
                if (c.apiKeyRef !== undefined && typeof c.apiKeyRef !== 'string') {
                  writeJson(400, { error: 'channel ' + i + ' apiKeyRef must be a string' })
                  return
                }
              }
              let existingList = Array.isArray(config.channels) ? config.channels : []
              try {
                const scope = requireScope()
                const snapshot = scope.getSnapshot()
                if (snapshot && snapshot.value && Array.isArray(snapshot.value.channels)) {
                  existingList = snapshot.value.channels
                }
              } catch (err) {
                /* settings scope probe fallback */
                void err
              }
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
              try {
                const scope = requireScope()
                await scope.set('channels', updated)
              } catch (err) {
                /* best-effort settings persistence */
                void err
              }
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

  // GET /dsh-vision-bridge/providers
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/providers',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
          if (!isTrustedSettingsRequest(req)) { writeJson(403, { error: 'forbidden: same-origin only' }); return }
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
}
