// #291: verification of modular route barrels and domain registrators
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes, registerConfigRoutes, registerDiagnosticRoutes, registerMaintenanceRoutes, registerMediaRoutes } from '../lib/routes/index.js'
import { setupWithAttachment, fakeRes, fakeReq } from './harness.js'

describe('#291 modular routes barrel & domain registration', async () => {
  it('exports all expected registrators from lib/routes/index.js', () => {
    assert.equal(typeof registerRoutes, 'function')
    assert.equal(typeof registerConfigRoutes, 'function')
    assert.equal(typeof registerDiagnosticRoutes, 'function')
    assert.equal(typeof registerMaintenanceRoutes, 'function')
    assert.equal(typeof registerMediaRoutes, 'function')
  })

  it('registers all standard routes on the mock context', async () => {
    const { ctx } = await setupWithAttachment()
    const expectedPaths = [
      '/dsh-vision-bridge/models',
      '/dsh-vision-bridge/config',
      '/dsh-vision-bridge/channels',
      '/dsh-vision-bridge/providers',
      '/dsh-vision-bridge/upload-pdf',
      '/dsh-vision-bridge/test',
      '/dsh-vision-bridge/bench',
      '/dsh-vision-bridge/doctor',
      '/dsh-vision-bridge/circuit',
      '/dsh-vision-bridge/stats',
      '/dsh-vision-bridge/costs',
      '/dsh-vision-bridge/journal',
      '/dsh-vision-bridge/batch',
      '/dsh-vision-bridge/cache',
    ]

    for (const p of expectedPaths) {
      assert.ok(ctx.routes.has(p), 'expected route to be registered: ' + p)
      const r = ctx.routes.get(p)
      assert.equal(typeof r.handler, 'function')
    }
  })

  it('GET /circuit returns the circuit states map as JSON', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/circuit').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.ok(body.circuits && typeof body.circuits === 'object')
  })

  it('GET /providers lists free vision providers catalog', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/providers').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.ok(Array.isArray(body.providers))
    assert.ok(body.providers.length >= 3)
    assert.ok(body.providers.some((p) => p.id === 'groq-free'))
  })
})
