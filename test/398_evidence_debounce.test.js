import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { EvidenceStore } from '../lib/evidence.js'

test('evidence store debounce & exit persistence (#398)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'))

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  await t.test('child node script persisting entry and exiting immediately writes vision-evidence.json', async () => {
    const exitDir = path.join(tmpDir, 'child-exit')
    const code = `
      import { EvidenceStore } from './lib/evidence.js';
      const store = new EvidenceStore(${JSON.stringify(exitDir)});
      store.set('key-exit', 'persisted on exit description');
    `

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    assert.equal(child.status, 0, 'Child process must exit with 0')
    const evidenceFile = path.join(exitDir, 'vision-evidence.json')
    assert.ok(fs.existsSync(evidenceFile), 'vision-evidence.json must exist after child exit')

    const raw = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
    assert.equal(raw['key-exit']?.description, 'persisted on exit description')

    // Read back via a new store instance
    const readStore = new EvidenceStore(exitDir)
    assert.equal(readStore.get('key-exit'), 'persisted on exit description')
  })

  await t.test('dispose() immediately flushes pending writes and cleans up', async () => {
    const dispDir = path.join(tmpDir, 'disp-test')
    const store = new EvidenceStore(dispDir)

    store.set('disp-key', 'flushed via dispose')
    assert.ok(store._flushTimer, 'Timer should be active before dispose')

    store.dispose()
    assert.equal(store._flushTimer, null, 'Timer must be cleared after dispose')

    const evidenceFile = path.join(dispDir, 'vision-evidence.json')
    assert.ok(fs.existsSync(evidenceFile))
    const raw = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
    assert.equal(raw['disp-key']?.description, 'flushed via dispose')
  })
})

