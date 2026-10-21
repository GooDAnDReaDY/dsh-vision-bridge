import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, plainConfig } from '../lib/index.js'
import { createMockCtx, fakeReq, fakeRes } from './harness.js'

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' }

describe('Issue #411: GET /config derives defaults dynamically from Config schema', () => {
  it('GET /config matches Config schema defaults out of the box', async () => {
    const ctx = createMockCtx({ config: {} })
    apply(ctx, ctx.config)

    const route = ctx.routes.get('/dsh-vision-bridge/config')
    assert.ok(route, '/config route must be registered')

    const res = fakeRes()
    await route.handler(fakeReq({ method: 'GET', headers: SAME_ORIGIN }), res)
    assert.equal(res.status, 200)

    const body = JSON.parse(res.body)
    const expectedDefaults = plainConfig(Config({}))

    assert.equal(body.mode, expectedDefaults.mode)
    assert.equal(body.describeStrategy, expectedDefaults.describeStrategy)
    assert.equal(body.escalation, expectedDefaults.escalation)
    assert.equal(body.channelOrderMode, expectedDefaults.channelOrderMode)
    assert.equal(body.maskPII, expectedDefaults.maskPII)
    assert.equal(body.maskSystemPaths, expectedDefaults.maskSystemPaths)
    assert.equal(body.stripEXIF, expectedDefaults.stripEXIF)
    assert.equal(body.consensusEnabled, expectedDefaults.consensusEnabled)
    assert.equal(body.deskew, expectedDefaults.deskew)
    assert.equal(body.enhanceImage, expectedDefaults.enhanceImage)
    assert.equal(body.selfCheckEnabled, expectedDefaults.selfCheckEnabled)
    assert.equal(body.imageMaxWidth, expectedDefaults.imageMaxWidth)
    assert.equal(body.imageMaxHeight, expectedDefaults.imageMaxHeight)
    assert.equal(body.imageQuality, expectedDefaults.imageQuality)
    assert.equal(body.attachMaxItems, expectedDefaults.attachMaxItems)
    assert.equal(body.hideRedundantTools, expectedDefaults.hideRedundantTools)
    assert.equal(body.channelFallback, expectedDefaults.channelFallback)
    assert.equal(body.channelTimeoutMs, expectedDefaults.channelTimeoutMs)
    assert.equal(body.channelCooldownMs, expectedDefaults.channelCooldownMs)
    assert.equal(body.nativePassthrough, expectedDefaults.nativePassthrough)
    assert.equal(body.cacheEnabled, expectedDefaults.cacheEnabled)
    assert.equal(body.evidencePersist, expectedDefaults.evidencePersist)
  })

  it('GET /config correctly reflects initial config overrides alongside schema defaults', async () => {
    const ctx = createMockCtx({
      config: {
        imageQuality: 92,
        attachMaxItems: 16,
        channelFallback: 'parallel-race',
      },
    })
    apply(ctx, ctx.config)

    const route = ctx.routes.get('/dsh-vision-bridge/config')
    const res = fakeRes()
    await route.handler(fakeReq({ method: 'GET', headers: SAME_ORIGIN }), res)
    assert.equal(res.status, 200)

    const body = JSON.parse(res.body)
    assert.equal(body.imageQuality, 92)
    assert.equal(body.attachMaxItems, 16)
    assert.equal(body.channelFallback, 'parallel-race')
    // Untouched fields must stay on their schema defaults
    const expectedDefaults = plainConfig(Config({}))
    assert.equal(body.imageMaxWidth, expectedDefaults.imageMaxWidth)
    assert.equal(body.imageMaxHeight, expectedDefaults.imageMaxHeight)
  })
})
