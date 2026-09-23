// #352: silence ENOENT on fresh start and resolve DSH data directory
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import { VisionJournal } from '../lib/journal.js'
import { EvidenceStore } from '../lib/evidence.js'
import { resolveStorageDir } from '../lib/index.js'

const dir = () => join(tmpdir(), 'vbr-352-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('#352 journal ENOENT silence and persistence across restarts', () => {
  it('does not throw or log when journal/evidence files do not exist initially', () => {
    const freshDir = dir()
    const j = new VisionJournal(freshDir, 100)
    assert.equal(j.size, 0)

    const e = new EvidenceStore(freshDir, 100)
    assert.equal(e.size, 0)
  })

  it('preserves entries across instance restart', async () => {
    const storage = dir()
    const j1 = new VisionJournal(storage, 100)
    j1.add({ channel: 'openai:gpt-4o', ok: true, prompt: 'describe' })
    await sleep(1100)

    const j2 = new VisionJournal(storage, 100)
    assert.equal(j2.size, 1)
    assert.equal(j2.recent(1)[0].channel, 'openai:gpt-4o')
  })

  it('resolves storage directory based on config or context', () => {
    const customConfig = { evidenceDir: '/custom/path' }
    assert.equal(resolveStorageDir({}, customConfig), '/custom/path')

    const withDataDir = resolveStorageDir({ dataDir: '/dsh/data' }, {})
    assert.equal(withDataDir, '/dsh/data')

    const withBaseDir = resolveStorageDir({ baseDir: '/dsh/home' }, {})
    assert.equal(withBaseDir, join('/dsh/home', 'data'))
  })
})
