import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment, fakeRes, fakeReq } from './harness.js'
import { isTrustedSettingsRequest, isLoopbackAddress } from '../lib/vision-core.js'

describe('Issue #308: sensitive routes and isTrustedSettingsRequest hardening', async () => {
  it('isLoopbackAddress verifies standard loopback representations', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true)
    assert.equal(isLoopbackAddress('127.0.0.2'), true)
    assert.equal(isLoopbackAddress('::1'), true)
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackAddress('192.168.1.1'), false)
    assert.equal(isLoopbackAddress('10.0.0.1'), false)
    assert.equal(isLoopbackAddress(''), false)
    assert.equal(isLoopbackAddress(null), false)
  })

  it('isTrustedSettingsRequest rejects empty, missing headers, or external clients without token', () => {
    assert.equal(isTrustedSettingsRequest(null), false)
    assert.equal(isTrustedSettingsRequest({}), false)
    assert.equal(isTrustedSettingsRequest({ headers: {} }), false)
    assert.equal(isTrustedSettingsRequest({ headers: {}, socket: { remoteAddress: '192.168.1.55' } }), false)
    assert.equal(isTrustedSettingsRequest({ headers: { 'sec-fetch-site': 'cross-site' }, socket: { remoteAddress: '127.0.0.1' } }), false)
    assert.equal(isTrustedSettingsRequest({ headers: { origin: 'http://malicious.com', host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }), false)
    assert.equal(isTrustedSettingsRequest({ headers: { origin: 'null', host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }), false)
  })

  it('isTrustedSettingsRequest accepts same-origin, loopback, or valid token', () => {
    assert.equal(isTrustedSettingsRequest({ headers: { 'sec-fetch-site': 'same-origin' } }), true)
    assert.equal(isTrustedSettingsRequest({ headers: { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:3080', host: 'localhost:3080' } }), true)
    assert.equal(isTrustedSettingsRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), true)
    assert.equal(isTrustedSettingsRequest({ headers: { authorization: 'Bearer secret-123' } }, 'secret-123'), true)
  })

  it('sensitive read routes reject untrusted external callers with 403', async () => {
    const { ctx } = await setupWithAttachment()
    const untrustedReq = (method, url) => fakeReq({
      method,
      url,
      headers: { host: 'localhost:3080' },
      socket: { remoteAddress: '192.168.1.100' }
    })

    const routesToCheck = [
      ['GET', '/dsh-vision-bridge/models'],
      ['GET', '/dsh-vision-bridge/config'],
      ['GET', '/dsh-vision-bridge/channels'],
      ['GET', '/dsh-vision-bridge/providers'],
      ['GET', '/dsh-vision-bridge/stats'],
      ['GET', '/dsh-vision-bridge/costs'],
      ['GET', '/dsh-vision-bridge/journal'],
      ['GET', '/dsh-vision-bridge/cache'],
      ['GET', '/dsh-vision-bridge/circuit'],
      ['GET', '/dsh-vision-bridge/telemetry'],
    ]

    for (const [method, path] of routesToCheck) {
      const route = ctx.routes.get(path)
      assert.ok(route, 'route exists: ' + path)
      const res = fakeRes()
      await route.handler(untrustedReq(method, path), res)
      assert.equal(res.status, 403, `route ${path} must reject untrusted request with 403`)
    }
  })

  it('sensitive read routes accept trusted loopback callers with 200', async () => {
    const { ctx } = await setupWithAttachment()
    const loopbackReq = (method, url) => fakeReq({
      method,
      url,
      headers: { host: 'localhost:3080' },
      socket: { remoteAddress: '127.0.0.1' }
    })

    const routesToTest = [
      ['GET', '/dsh-vision-bridge/config'],
      ['GET', '/dsh-vision-bridge/channels'],
      ['GET', '/dsh-vision-bridge/stats'],
      ['GET', '/dsh-vision-bridge/costs'],
      ['GET', '/dsh-vision-bridge/circuit'],
      ['GET', '/dsh-vision-bridge/telemetry'],
    ]

    for (const [method, path] of routesToTest) {
      const route = ctx.routes.get(path)
      assert.ok(route, 'route exists: ' + path)
      const res = fakeRes()
      await route.handler(loopbackReq(method, path), res)
      assert.equal(res.status, 200, `route ${path} must accept loopback with 200`)
    }
  })

  it('write routes reject disallowed HTTP methods with 405', async () => {
    const { ctx } = await setupWithAttachment()
    const reqPut = fakeReq({ method: 'PUT', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } })

    const configHandler = ctx.routes.get('/dsh-vision-bridge/config').handler
    const resPutConfig = fakeRes()
    await configHandler(reqPut, resPutConfig)
    assert.equal(resPutConfig.status, 405)

    const channelsHandler = ctx.routes.get('/dsh-vision-bridge/channels').handler
    const resPutChannels = fakeRes()
    await channelsHandler(reqPut, resPutChannels)
    assert.equal(resPutChannels.status, 405)
  })
})
