// #347: EvidenceStore O(1) eviction and atomic file persistence
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceStore } from '../lib/evidence.js'
import { VisionJournal } from '../lib/journal.js'

const dir = () => join(tmpdir(), 'vbr-347-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('#347 EvidenceStore eviction and atomic writes', () => {
  it('evicts oldest keys in natural insertion order without sorting overhead', () => {
    const d = dir()
    const store = new EvidenceStore(d, 3)
    store.set('k1', 'val1')
    store.set('k2', 'val2')
    store.set('k3', 'val3')
    assert.equal(store.size, 3)

    // Updating k1 moves it to newest
    store.set('k1', 'val1-updated')
    // Adding k4 should evict k2 (oldest), keeping k3, k1, k4
    store.set('k4', 'val4')
    assert.equal(store.size, 3)
    assert.equal(store.get('k2'), undefined, 'k2 was oldest and must be evicted')
    assert.equal(store.get('k1'), 'val1-updated')
    assert.equal(store.get('k3'), 'val3')
    assert.equal(store.get('k4'), 'val4')
  })

  it('persists EvidenceStore atomically via temp file without leaving dangling tmp files', async () => {
    const d = dir()
    const store = new EvidenceStore(d, 10)
    store.set('k1', 'desc1')
    await sleep(1100)

    const targetFile = join(d, 'vision-evidence.json')
    assert.ok(existsSync(targetFile), 'target file must exist')
    const raw = readFileSync(targetFile, 'utf8')
    assert.ok(raw.includes('desc1'))

    // Verify no leftover .tmp files
    const fs = await import('node:fs')
    const leftovers = fs.readdirSync(d).filter((f) => f.endsWith('.tmp'))
    assert.equal(leftovers.length, 0, 'no dangling .tmp files after atomic rename')
  })

  it('persists VisionJournal atomically via temp file', async () => {
    const d = dir()
    const journal = new VisionJournal(d, 10)
    journal.add({ channel: 'test', ok: true })
    await sleep(1100)

    const targetFile = join(d, 'vision-journal.json')
    assert.ok(existsSync(targetFile), 'journal file must exist')
    const raw = readFileSync(targetFile, 'utf8')
    assert.ok(raw.includes('test'))

    const fs = await import('node:fs')
    const leftovers = fs.readdirSync(d).filter((f) => f.endsWith('.tmp'))
    assert.equal(leftovers.length, 0, 'no dangling .tmp files after atomic rename')
  })
})
