import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { apply, isMaskedKey } from '../lib/index.js'
import { createMockCtx, fakeReq, fakeRes } from './harness.js'

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' }

describe('Issues #374 & #410: Channels persistence via settings scope', () => {
  it('POST /channels persists configured channels to settings scope and returns masked keys', async () => {
    const ctx = createMockCtx({ config: {} })
    const storage = { ns: 'dsh-vision-bridge', revision: 1, value: {} }
    ctx.settings = {
      describe: () => [storage],
      update: async (ns, val, rev) => {
        storage.value = { ...storage.value, ...val }
        storage.revision++
      },
    }

    apply(ctx, ctx.config)

    const route = ctx.routes.get('/dsh-vision-bridge/channels')
    assert.ok(route, '/channels route must be registered')

    const res = fakeRes()
    await route.handler(
      fakeReq({
        method: 'POST',
        headers: SAME_ORIGIN,
        body: JSON.stringify({
          channels: [
            { type: 'custom', baseURL: 'http://custom-vision.local/v1', apiKey: 'sk-secret-key-123456789' },
          ],
        }),
      }),
      res,
    )

    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.channels.length, 1)
    assert.equal(body.channels[0].hasApiKey, true)
    assert.ok(isMaskedKey(body.channels[0].apiKey), 'Returned key must be masked')

    // Crucial check: storage must contain the unmasked key!
    assert.ok(Array.isArray(storage.value.channels), 'Storage must have channels array')
    assert.equal(storage.value.channels.length, 1)
    assert.equal(storage.value.channels[0].apiKey, 'sk-secret-key-123456789', 'Persisted key must NOT be masked')
  })

  it('POST /channels round-trip: preserves unmasked keys when receiving masked keys back from UI', async () => {
    const ctx = createMockCtx({ config: {} })
    const storage = {
      ns: 'dsh-vision-bridge',
      revision: 1,
      value: {
        channels: [
          { type: 'custom', baseURL: 'http://custom-vision.local/v1', apiKey: 'sk-secret-key-123456789' },
        ],
      },
    }
    ctx.settings = {
      describe: () => [storage],
      update: async (ns, val, rev) => {
        storage.value = { ...storage.value, ...val }
        storage.revision++
      },
    }

    apply(ctx, ctx.config)

    const route = ctx.routes.get('/dsh-vision-bridge/channels')
    const getRes = fakeRes()
    await route.handler(fakeReq({ method: 'GET', headers: SAME_ORIGIN }), getRes)
    const getBody = JSON.parse(getRes.body)
    const maskedChannel = getBody.channels[0]
    assert.ok(isMaskedKey(maskedChannel.apiKey), 'Key must be masked on GET')

    // Simulate UI re-saving the form with the masked key
    const postRes = fakeRes()
    await route.handler(
      fakeReq({
        method: 'POST',
        headers: SAME_ORIGIN,
        body: JSON.stringify({
          channels: [maskedChannel],
        }),
      }),
      postRes,
    )

    assert.equal(postRes.status, 200)
    assert.equal(storage.value.channels[0].apiKey, 'sk-secret-key-123456789', 'Unmasked key must be preserved in storage')
  })

  it('Persisted channels survive plugin reload / restart', async () => {
    // 1. Initial run: save channels
    const sharedStorage = { ns: 'dsh-vision-bridge', revision: 1, value: {} }
    const ctx1 = createMockCtx({ config: {} })
    ctx1.settings = {
      describe: () => [sharedStorage],
      update: async (ns, val, rev) => {
        sharedStorage.value = { ...sharedStorage.value, ...val }
        sharedStorage.revision++
      },
    }
    apply(ctx1, ctx1.config)

    const route1 = ctx1.routes.get('/dsh-vision-bridge/channels')
    await route1.handler(
      fakeReq({
        method: 'POST',
        headers: SAME_ORIGIN,
        body: JSON.stringify({
          channels: [
            { type: 'ollama', baseURL: 'http://localhost:11434', model: 'llava:7b' },
          ],
        }),
      }),
      fakeRes(),
    )

    // 2. Restart simulation: create a new ctx with the same persisted storage
    const ctx2 = createMockCtx({ config: {} })
    ctx2.settings = {
      describe: () => [sharedStorage],
      update: async (ns, val, rev) => {
        sharedStorage.value = { ...sharedStorage.value, ...val }
        sharedStorage.revision++
      },
    }
    apply(ctx2, ctx2.config)

    const route2 = ctx2.routes.get('/dsh-vision-bridge/channels')
    const getRes = fakeRes()
    await route2.handler(fakeReq({ method: 'GET', headers: SAME_ORIGIN }), getRes)
    assert.equal(getRes.status, 200)

    const body = JSON.parse(getRes.body)
    assert.equal(body.channels.length, 1, 'Channels must survive restart')
    assert.equal(body.channels[0].type, 'ollama')
    assert.equal(body.channels[0].model, 'llava:7b')
  })

  it('POST /config persists channels if provided in extraFields', async () => {
    const ctx = createMockCtx({ config: {} })
    const storage = { ns: 'dsh-vision-bridge', revision: 1, value: {} }
    ctx.settings = {
      describe: () => [storage],
      update: async (ns, val, rev) => {
        storage.value = { ...storage.value, ...val }
        storage.revision++
      },
    }
    apply(ctx, ctx.config)

    const route = ctx.routes.get('/dsh-vision-bridge/config')
    const res = fakeRes()
    await route.handler(
      fakeReq({
        method: 'POST',
        headers: SAME_ORIGIN,
        body: JSON.stringify({
          channels: [{ type: 'custom', baseURL: 'http://custom.com' }],
        }),
      }),
      res,
    )

    assert.equal(res.status, 200)
    assert.ok(Array.isArray(storage.value.channels))
    assert.equal(storage.value.channels[0].baseURL, 'http://custom.com')
  })
})
