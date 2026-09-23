import { bestEffort } from './vision-core.js'
// dsh-vision-bridge — evidence store (Block 4, 0.2.9).
//
// Persists image descriptions across sessions in a JSON file (no sqlite dep).
// Key: composite cacheKey (bytes+prompt+model+mode). Value: {description, ts}.
// ponytail: JSON append-only file with LRU cap; upgrade to better-sqlite3 if
// the store grows past ~5k entries.

import fs from 'node:fs'
import path from 'node:path'

export class EvidenceStore {
  constructor(dir, maxEntries = 2000) {
    this.file = path.join(dir, 'vision-evidence.json')
    this.max = maxEntries
    this.map = new Map()
    // #286: silent write failures made persistence look real when it was not.
    this.writeErrors = 0
    bestEffort('evidence.load', () => {
      const raw = fs.readFileSync(this.file, 'utf8')
      for (const [k, v] of Object.entries(JSON.parse(raw))) this.map.set(k, v)
    })
  }
  get(key) {
    const hit = this.map.get(key)
    return hit && typeof hit.description === 'string' ? hit.description : undefined
  }
  set(key, description) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { description, ts: Date.now() })
    while (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey !== undefined) this.map.delete(oldestKey)
      else break
    }
    this.flush()
  }
  recent(n = 20) {
    return [...this.map.values()].sort((a, b) => b.ts - a.ts).slice(0, n)
  }
  get size() {
    return this.map.size
  }
  clear() {
    this.map.clear()
    this.flush()
  }
  flush() {
    if (this._flushTimer) return
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const tmp = `${this.file}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)))
        fs.renameSync(tmp, this.file)
      } catch {
        // #286: count so /doctor and /stats can surface the loss.
        this.writeErrors++
      }
    }, 1000)
    if (this._flushTimer && typeof this._flushTimer.unref === 'function') {
      this._flushTimer.unref()
    }
  }
}
