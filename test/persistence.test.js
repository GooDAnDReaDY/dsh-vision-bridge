// #232: persistence units — EvidenceStore and VisionJournal round-trips,
// caps and debounce flushes, exercised against a per-test tmp directory.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceStore } from '../lib/evidence.js'
import { VisionJournal } from '../lib/journal.js'

const dir = () => join(tmpdir(), 'vbr-persist-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('EvidenceStore persistence (#232)', async () => {
  it('flushes entries to disk and loads them back in a new instance', async () => {
    const d = dir()
    const a = new EvidenceStore(d, 10)
    a.set('k1', 'description one')
    a.set('k2', 'description two')
    await sleep(1200)
    assert.ok(existsSync(join(d, 'vision-evidence.json')), 'evidence file written after flush')

    const b = new EvidenceStore(d, 10)
    assert.equal(b.get('k1'), 'description one')
    assert.equal(b.get('k2'), 'description two')
  })

  it('caps the store at maxEntries, evicting the oldest', async () => {
    const d = dir()
    const a = new EvidenceStore(d, 2)
    a.set('a', 'one'); a.set('b', 'two'); a.set('c', 'three')
    assert.equal(a.size, 2)
    assert.equal(a.get('a'), undefined, 'oldest evicted')
    assert.equal(a.get('c'), 'three')
  })
})

describe('VisionJournal persistence and caps (#232)', async () => {
  it('round-trips entries through the file', async () => {
    const d = dir()
    const a = new VisionJournal(d, 50)
    a.add({ ok: true, channel: 'dsh-catalog:prov/m1' })
    a.add({ ok: false, channel: 'webhook:', reason: 'x' })
    await sleep(1200)
    assert.ok(existsSync(join(d, 'vision-journal.json')))

    const b = new VisionJournal(d, 50)
    assert.equal(b.size, 2)
    assert.equal(b.filter({ ok: false }).length, 1)
  })

  it('caps entries at maxEntries', () => {
    const d = dir()
    const a = new VisionJournal(d, 3)
    for (let i = 0; i < 10; i++) a.add({ ok: true, channel: 'c' + i })
    assert.equal(a.size, 3)
  })
})
