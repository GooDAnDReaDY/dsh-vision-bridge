import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { createMockCtx, fakeReq, fakeRes } from './harness.js'

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' }

describe('Issue #363 & #370: Modern DSH Settings Service adaptation without register()', () => {
  it('GET /config returns active settings when settings.register is absent', async () => {
    const ctx = createMockCtx({
      config: { imageMaxWidth: 777, mode: 'tools' },
    })
    // Simulate modern DSH: register is removed, describe/update/replace exist
    const storage = {
      ns: 'dsh-vision-bridge',
      revision: 1,
      value: { imageMaxWidth: 777, mode: 'tools', visionProvider: 'mock-p', visionModel: 'mock-m' },
    }
    ctx.settings = {
      describe: () => [storage],
      update: async (ns, patch, rev) => {
        storage.value = { ...storage.value, ...patch }
        storage.revision++
      },
      replace: async (ns, val, rev) => {
        storage.value = val
        storage.revision++
      },
    }

    apply(ctx, ctx.config)

    const route = ctx.routes.get('/dsh-vision-bridge/config')
    assert.ok(route, '/config route must be registered')

    const res = fakeRes()
    await route.handler(fakeReq({ method: 'GET', headers: SAME_ORIGIN }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.imageMaxWidth, 777, 'imageMaxWidth should be 777 from settings snapshot')
    assert.equal(body.mode, 'tools')
    assert.equal(body.provider, 'mock-p')
    assert.equal(body.model, 'mock-m')
  })

  it('POST /config updates settings and returns 200 without throwing 500 when register() is absent', async () => {
    const ctx = createMockCtx({ config: {} })
    let lastUpdate = null
    const storage = { ns: 'dsh-vision-bridge', revision: 2, value: { mode: 'hybrid' } }
    ctx.settings = {
      describe: () => [storage],
      update: async (ns, val, rev) => {
        lastUpdate = { ns, val, rev }
        storage.value = val
      },
    }

    apply(ctx, ctx.config)

    const route = ctx.routes.get('/dsh-vision-bridge/config')
    const res = fakeRes()
    await route.handler(fakeReq({
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({
        mode: 'tools',
        imageMaxWidth: 1024,
        provider: 'custom-p',
        model: 'custom-m',
      }),
    }), res)

    assert.equal(res.status, 200, 'POST /config must return 200 OK')
    const body = JSON.parse(res.body)
    assert.equal(body.mode, 'tools')
    assert.equal(body.provider, 'custom-p')
    assert.equal(body.model, 'custom-m')
    assert.ok(lastUpdate, 'settings.update must have been called')
    assert.equal(lastUpdate.ns, 'dsh-vision-bridge')
    assert.equal(lastUpdate.val.mode, 'tools')
    assert.equal(lastUpdate.val.imageMaxWidth, 1024)
  })

  it('requireScope never throws even when settings service is completely absent', async () => {
    const ctx = createMockCtx({ config: { imageMaxWidth: 800 } })
    ctx.settings = null // completely absent

    apply(ctx, ctx.config)

    const route = ctx.routes.get('/dsh-vision-bridge/config')
    const getRes = fakeRes()
    await route.handler(fakeReq({ method: 'GET', headers: SAME_ORIGIN }), getRes)
    assert.equal(getRes.status, 200)

    const postRes = fakeRes()
    await route.handler(fakeReq({
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ mode: 'tools' }),
    }), postRes)
    assert.equal(postRes.status, 200, 'POST /config must not fail with 500 when settings service is absent')
  })

  it('reacts to settings/document-updated event from host', async () => {
    const ctx = createMockCtx({ config: {} })
    ctx.settings = null

    apply(ctx, ctx.config)

    // Trigger host document update event
    const listeners = ctx.listeners.get('settings/document-updated') || []
    assert.ok(listeners.length > 0, 'Must register listener for settings/document-updated')

    for (const listener of listeners) {
      listener({ ns: 'dsh-vision-bridge', value: { imageMaxWidth: 1440, mode: 'llm' } })
    }

    const route = ctx.routes.get('/dsh-vision-bridge/config')
    const res = fakeRes()
    await route.handler(fakeReq({ method: 'GET', headers: SAME_ORIGIN }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.imageMaxWidth, 1440)
    assert.equal(body.mode, 'llm')
  })
})
