import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedSettingsRequest } from '../lib/vision-core.js'

describe('Issue #375: isTrustedSettingsRequest remote header spoofing protection', () => {
  it('rejects external IP sending forged sec-fetch-site: same-origin without token', () => {
    const forgedReq = {
      headers: {
        'sec-fetch-site': 'same-origin',
      },
      socket: { remoteAddress: '192.168.1.150' },
    }
    assert.equal(isTrustedSettingsRequest(forgedReq), false, 'Non-loopback caller with forged same-origin header must be rejected')
  })

  it('rejects external IP sending forged sec-fetch-site and matching host/origin without token', () => {
    const forgedReq = {
      headers: {
        'sec-fetch-site': 'same-origin',
        origin: 'http://192.168.1.111:3005',
        host: '192.168.1.111:3005',
      },
      socket: { remoteAddress: '192.168.1.55' },
    }
    assert.equal(isTrustedSettingsRequest(forgedReq), false, 'External IP must not bypass auth with matching Origin/Host')
  })

  it('accepts external IP when authenticated with valid token secret', () => {
    const validReq = {
      headers: {
        'sec-fetch-site': 'same-origin',
        authorization: 'Bearer expected-secret-999',
      },
      socket: { remoteAddress: '192.168.1.55' },
    }
    assert.equal(isTrustedSettingsRequest(validReq, 'expected-secret-999'), true, 'External IP with valid token must be accepted')
  })

  it('accepts loopback caller sending sec-fetch-site: same-origin', () => {
    const loopbackReq = {
      headers: {
        'sec-fetch-site': 'same-origin',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.equal(isTrustedSettingsRequest(loopbackReq), true, 'Loopback same-origin request must be accepted')
  })

  it('accepts loopback caller without headers', () => {
    const loopbackReq = {
      headers: {},
      socket: { remoteAddress: '::1' },
    }
    assert.equal(isTrustedSettingsRequest(loopbackReq), true, 'Loopback socket must be accepted')
  })

  it('accepts mock request with sec-fetch-site: same-origin and no remote socket', () => {
    const mockReq = {
      headers: {
        'sec-fetch-site': 'same-origin',
      },
    }
    assert.equal(isTrustedSettingsRequest(mockReq), true, 'Mock request without socket must pass same-origin test')
  })

  it('rejects loopback caller with mismatched origin (CSRF protection)', () => {
    const badOriginReq = {
      headers: {
        origin: 'http://evil.com',
        host: '127.0.0.1:3005',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.equal(isTrustedSettingsRequest(badOriginReq), false, 'Mismatched origin must be rejected even from loopback')
  })
})
