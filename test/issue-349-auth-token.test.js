import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedSettingsRequest } from '../lib/vision-core.js'

describe('Issue #349: isTrustedSettingsRequest authentication hardening', () => {
  it('rejects arbitrary Bearer tokens and cookies when secret is not matched', () => {
    // Arbitrary bearer without matching secret must be rejected
    const reqBearerX = { headers: { authorization: 'Bearer x' }, socket: { remoteAddress: '192.168.1.50' } }
    assert.equal(isTrustedSettingsRequest(reqBearerX), false, 'Bearer x without secret must be rejected')

    const reqBearerLong = { headers: { authorization: 'Bearer arbitrary-long-token' }, socket: { remoteAddress: '192.168.1.50' } }
    assert.equal(isTrustedSettingsRequest(reqBearerLong), false, 'Arbitrary long bearer token must be rejected')

    // Arbitrary cookie without matching secret must be rejected
    const reqCookie = { headers: { cookie: 'token=arbitrary' }, socket: { remoteAddress: '192.168.1.50' } }
    assert.equal(isTrustedSettingsRequest(reqCookie), false, 'Cookie substring without secret must be rejected')
  })

  it('accepts Bearer token and cookie only when matching expectedToken', () => {
    const secret = 'my-super-secret-token'
    const reqGood = { headers: { authorization: 'Bearer ' + secret }, socket: { remoteAddress: '192.168.1.50' } }
    assert.equal(isTrustedSettingsRequest(reqGood, secret), true, 'Matching bearer must be accepted')

    const reqBad = { headers: { authorization: 'Bearer wrong-secret' }, socket: { remoteAddress: '192.168.1.50' } }
    assert.equal(isTrustedSettingsRequest(reqBad, secret), false, 'Non-matching bearer must be rejected')

    const reqGoodCookie = { headers: { cookie: 'foo=bar; token=' + secret + '; other=1' }, socket: { remoteAddress: '192.168.1.50' } }
    assert.equal(isTrustedSettingsRequest(reqGoodCookie, secret), true, 'Matching cookie must be accepted')

    const reqBadCookie = { headers: { cookie: 'token=wrong-secret' }, socket: { remoteAddress: '192.168.1.50' } }
    assert.equal(isTrustedSettingsRequest(reqBadCookie, secret), false, 'Non-matching cookie must be rejected')
  })

  it('unconditionally rejects cross-site requests regardless of token', () => {
    const secret = 'my-super-secret-token'
    const reqCrossSite = {
      headers: {
        authorization: 'Bearer ' + secret,
        'sec-fetch-site': 'cross-site',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.equal(isTrustedSettingsRequest(reqCrossSite, secret), false, 'cross-site requests must always be rejected')
  })
})
