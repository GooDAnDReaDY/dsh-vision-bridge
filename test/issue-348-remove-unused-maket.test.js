// #348: ensure dead function _unused_makeT is removed
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('#348 dead code removal in client.js', () => {
  it('does not contain _unused_makeT', () => {
    const clientPath = join(__dirname, '../lib/client.js')
    const content = readFileSync(clientPath, 'utf8')
    assert.equal(content.includes('_unused_makeT'), false, '_unused_makeT must not be present in client.js')
  })
})
