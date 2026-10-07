import { EvidenceStore } from './evidence.js'
import { VisionJournal } from './journal.js'

export const BATCH_TTL_MS = 10 * 60 * 1000

export function setupJournalAndEvidence(ctx, config, storageDir) {
  // Block 4 (0.2.9): optional persistent evidence store behind the LRU.
  const evidenceStore = config.evidencePersist ? new EvidenceStore(storageDir, config.evidenceMaxEntries) : null
  if (evidenceStore) {
    ctx.effect(() => () => {
      evidenceStore.dispose()
    }, 'dsh-vision-bridge: flush evidence store on unload')
  }

  // #108: vision journal — audit trail of every vision call.
  const journal = new VisionJournal(storageDir, config.evidenceMaxEntries)

  // #203: auditLog now actually gates the journal: 'off' records nothing (and
  // nothing hits the disk), 'errors' records failures only, 'all' every call.
  const journalAdd = (entry) => {
    if (config.auditLog === 'all' || (config.auditLog === 'errors' && entry.ok === false)) {
      journal.add(entry)
    }
  }

  // #110, #397: batch manager — track in-flight batches for progress + cancel.
  const batches = new Map()
  let batchSeq = 0

  ctx.effect(() => () => {
    for (const b of batches.values()) {
      if (b.ttlTimer) clearTimeout(b.ttlTimer)
      if (b.ctrl && !b.ctrl.signal.aborted) b.ctrl.abort()
    }
    batches.clear()
  }, 'dsh-vision-bridge: cancel batches on unload')

  const startBatch = async (items, prompt, callVisionModel) => {
    const id = 'b' + (++batchSeq)
    const ctrl = new AbortController()
    const state = { id, prompt, total: items.length, done: 0, ok: 0, failed: 0, results: [], cancelled: false, startedAt: Date.now() }
    batches.set(id, { state, ctrl })
    ;(async () => {
      for (const item of items) {
        if (ctrl.signal.aborted) { state.cancelled = true; break }
        try {
          const r = await callVisionModel(item.bytes, item.contentType, prompt || 'Describe this image.', { signal: ctrl.signal })
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
      const rec = batches.get(id)
      if (!rec) return
      const ttl = setTimeout(() => { batches.delete(id) }, BATCH_TTL_MS)
      if (typeof ttl.unref === 'function') ttl.unref()
      rec.ttlTimer = ttl
    })()
    return id
  }

  // #172: track last N vision requests for debug
  const lastRequests = []
  const trackRequest = (info) => {
    lastRequests.push({ ts: Date.now(), ...info })
    if (lastRequests.length > 20) lastRequests.shift()
  }

  return {
    evidenceStore,
    journal,
    journalAdd,
    batches,
    startBatch,
    lastRequests,
    trackRequest,
  }
}
