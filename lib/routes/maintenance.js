import { bestEffort } from '../vision-core.js'
// #291: maintenance & telemetry domain routes
import { isTrustedSettingsRequest } from '../vision-core.js'

export function registerMaintenanceRoutes(ctx, deps) {
  const { usageByChannel, lastRequests, journal, batches, attachmentById, resolveImageBytes, startBatch, descriptionByHash, evidenceStore, descriptionByAttachmentId } = deps

  // GET /dsh-vision-bridge/stats
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
          writeJson(200, { channels: out, lastRequests, persistence: { journalWriteErrors: journal.writeErrors || 0, evidenceWriteErrors: evidenceStore ? (evidenceStore.writeErrors || 0) : 0 } })
        },
      }),
    'dsh-vision-bridge: /stats route',
  )

  // GET /dsh-vision-bridge/costs
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/costs',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
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

  // GET & DELETE /dsh-vision-bridge/journal
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/journal',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method === 'DELETE') {
            if (!isTrustedSettingsRequest(req)) { writeJson(403, { error: 'forbidden: same-origin only' }); return }
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

  // GET, POST, DELETE /dsh-vision-bridge/batch
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-vision-bridge/batch',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if ((req.method === 'POST' || req.method === 'DELETE') && !isTrustedSettingsRequest(req)) { writeJson(403, { error: 'forbidden: same-origin only' }); return }
          const url = new URL(req.url, 'http://localhost')
          const parts = url.pathname.split('/').filter(Boolean)
          const id = parts[2]
          if (req.method === 'POST' && !id) {
            let body = {}
            body = (await bestEffort('routes.maintenance.bodyRead', () => new Promise((resolve) => { let c = ''; req.on('data', (d) => { c += d }); req.on('end', () => { resolve(bestEffort('routes.maintenance.jsonParse', () => JSON.parse(c), {}) || {}) }) }), {})) || {}
            const ids = Array.isArray(body.attachmentIds) ? body.attachmentIds : []
            if (ids.length === 0) { writeJson(400, { error: 'attachmentIds required' }); return }
            const items = []
            for (const id of ids) {
              const ref = attachmentById.get(String(id))
              if (!ref) { writeJson(400, { error: 'unknown attachmentId ' + id }); return }
              const src = await resolveImageBytes(ref)
              if (!src) { writeJson(400, { error: 'cannot read ' + id }); return }
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
          if (req.method === 'DELETE' && id) {
            const b = batches.get(id)
            if (!b) { writeJson(404, { error: 'batch not found' }); return }
            if (b.ttlTimer) clearTimeout(b.ttlTimer)
            batches.delete(id)
            writeJson(200, { ok: true, released: true })
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

  // GET & DELETE /dsh-vision-bridge/cache
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/cache',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method === 'DELETE') {
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
}
