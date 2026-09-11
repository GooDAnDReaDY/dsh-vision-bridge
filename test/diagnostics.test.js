// #284/#285/#286: numeric settings validation, /doctor diagnostics (version,
// storage probe, persistence counters) and silent write-failure surfacing.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment, fakeReq, fakeRes } from './harness.js'

const config = (body) => fakeReq({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) })

describe('#284 numeric settings validation', async () => {
  it('accepts in-range values', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/config').handler
    const res = fakeRes()
    await handler(config({ imageMaxWidth: 1920, imageMaxHeight: 1080, imageQuality: 80, cacheMaxEntries: 200, timeoutMs: 120000 }), res)
    assert.equal(res.status, 200)
    const d = JSON.parse(res.body)
    assert.equal(d.imageMaxWidth, 1920)
    assert.equal(d.imageQuality, 80)
  })

  it('rejects out-of-range and non-numeric values with 400', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/config').handler
    for (const body of [
      { imageMaxWidth: 0 },
      { imageMaxWidth: -100 },
      { imageMaxWidth: 'wide' },
      { imageQuality: 0 },
      { imageQuality: 101 },
      { imageQuality: 'high' },
      { cacheMaxEntries: 0 },
      { timeoutMs: -1 },
      { channelCooldownMs: 'never' },
    ]) {
      const res = fakeRes()
      await handler(config(body), res)
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} must be rejected`)
      const err = JSON.parse(res.body).error
      assert.match(err, /must be an integer between/)
    }
  })

  it('does not persist a rejected value', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/config').handler
    await handler(config({ imageMaxWidth: -1 }), fakeRes())
    const get = fakeRes()
    await handler(fakeReq({ method: 'GET' }), get)
    assert.equal(JSON.parse(get.body).imageMaxWidth, 1920, 'the default must survive a rejected write')
  })
})

describe('#285 doctor diagnostics', async () => {
  it('reports the plugin version', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/doctor').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    assert.equal(res.status, 200)
    const d = JSON.parse(res.body)
    assert.ok(d.summary.version, 'version must be present in the summary')
    assert.match(d.summary.version, /^\d+\.\d+\.\d+/)
  })

  it('reports storage probe results with ?probe=1', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/doctor').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET', url: '/dsh-vision-bridge/doctor?probe=1' }), res)
    assert.equal(res.status, 200)
    const d = JSON.parse(res.body)
    assert.ok(d.summary.storage, 'storage probe must run with ?probe=1')
    assert.equal(typeof d.summary.storage.ok, 'boolean')
    if (!d.summary.storage.ok) assert.ok(d.summary.storage.error, 'a failed probe must carry the error')
  })

  it('reports persistence error counters', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/doctor').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    const d = JSON.parse(res.body)
    assert.ok(d.summary.persistence, 'persistence counters must be present')
    assert.equal(typeof d.summary.persistence.journalWriteErrors, 'number')
    assert.equal(typeof d.summary.persistence.evidenceWriteErrors, 'number')
  })
})

describe('#286 persistence write error surfacing', async () => {
  it('stats route reports persistence counters', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/stats').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    assert.equal(res.status, 200)
    const d = JSON.parse(res.body)
    assert.ok(d.persistence, 'persistence counters must be in /stats')
    assert.equal(typeof d.persistence.journalWriteErrors, 'number')
  })
})
