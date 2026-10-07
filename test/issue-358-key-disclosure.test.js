import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveKeyLabel } from '../lib/channels.js'

describe('Issue #358: non-disclosure of API key characters in keyUsed', () => {
  const secretKey = 'sk-proj-1234567890abcdef1234567890abcdef'

  it('deriveKeyLabel produces a stable, non-secret hash label', () => {
    const label1 = deriveKeyLabel(secretKey)
    const label2 = deriveKeyLabel(secretKey)

    assert.equal(label1, label2, 'must be deterministic and stable')
    assert.match(label1, /^key#[0-9a-f]{8}$/, 'must follow key#<hash> format')
  })

  it('deriveKeyLabel incorporates apiKeyRef when provided without leaking key characters', () => {
    const label = deriveKeyLabel(secretKey, 'OPENAI_API_KEY')
    assert.match(label, /^OPENAI_API_KEY#[0-9a-f]{8}$/)
  })

  it('deriveKeyLabel never discloses raw key characters or prefix', () => {
    const label = deriveKeyLabel(secretKey)
    const prefix = secretKey.slice(0, 8) // 'sk-proj-'
    assert.equal(label.includes(prefix), false, 'must not include prefix')
    assert.equal(label.includes('sk-'), false, 'must not include sk-')
    assert.equal(label.includes(secretKey), false, 'must not include full key')
  })

  it('deriveKeyLabel handles empty, null or missing keys gracefully', () => {
    assert.equal(deriveKeyLabel(''), '(no key)')
    assert.equal(deriveKeyLabel(null), '(no key)')
    assert.equal(deriveKeyLabel(undefined), '(no key)')
    assert.equal(deriveKeyLabel('   '), '(no key)')
  })

  it('different keys produce different labels', () => {
    const keyA = 'sk-test-key-alpha-9999999999'
    const keyB = 'sk-test-key-beta-8888888888'
    assert.notEqual(deriveKeyLabel(keyA), deriveKeyLabel(keyB))
  })
})
