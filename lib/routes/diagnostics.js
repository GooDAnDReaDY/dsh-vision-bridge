// #291: diagnostics & test domain routes
import { isTrustedSettingsRequest } from '../vision-core.js'
import { channelKey, runChannels } from '../channels.js'

export function registerDiagnosticRoutes(ctx, deps) {
  const { config, liveChannels, callVisionModelWithBytes, channelCircuitStates, journal, evidenceStore, pluginVersion, probeStorage } = deps

  // POST /dsh-vision-bridge/test
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

  // POST /dsh-vision-bridge/bench
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/bench',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'POST') { writeJson(405, { error: 'method not allowed' }); return }
          if (!isTrustedSettingsRequest(req)) { writeJson(403, { error: 'forbidden: same-origin only' }); return }
          const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
          const list = await liveChannels()
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

  // GET /dsh-vision-bridge/doctor
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/doctor',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
          const doProbe = new URL(req.url, 'http://localhost').searchParams.get('probe') === '1'
          if (doProbe && !isTrustedSettingsRequest(req)) { writeJson(403, { error: 'forbidden: same-origin only' }); return }
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
            version: pluginVersion,
            storage: doProbe ? await probeStorage() : undefined,
            persistence: {
              journalWriteErrors: journal.writeErrors || 0,
              evidenceWriteErrors: evidenceStore ? (evidenceStore.writeErrors || 0) : 0,
            },
          }
          writeJson(200, { summary, channels: report })
        },
      }),
    'dsh-vision-bridge: /doctor route',
  )

  // GET /dsh-vision-bridge/circuit
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
}
