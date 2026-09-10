// #232: executable coverage for the routes that had none — /upload-pdf,
// /bench with a failing channel, the /batch flow and POST /test.
// All channels used here fail fast without touching the network
// (webhook without baseURL is rejected before any fetch).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment, createMockCtx, fakeRes, fakeReq } from './harness.js'

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' }

describe('POST /upload-pdf (#228)', async () => {
  it('rejects a payload above maxPdfBytes with 413 (declared length)', async () => {
    const { ctx } = await setupWithAttachment({ config: { maxPdfBytes: 64 } })
    const handler = ctx.routes.get('/dsh-vision-bridge/upload-pdf').handler
    const res = fakeRes()
    const big = 'x'.repeat(128)
    await handler(fakeReq({ method: 'POST', headers: { ...SAME_ORIGIN, 'content-length': String(big.length) }, body: big }), res)
    assert.equal(res.status, 413)
  })

  it('rejects a streaming payload that grows past maxPdfBytes mid-read', async () => {
    const { ctx } = await setupWithAttachment({ config: { maxPdfBytes: 64 } })
    const handler = ctx.routes.get('/dsh-vision-bridge/upload-pdf').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: { ...SAME_ORIGIN }, body: 'y'.repeat(200) }), res)
    assert.equal(res.status, 413)
  })

  it('accepts a small payload and surfaces the render failure as 422', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/upload-pdf').handler
    const res = fakeRes()
    // not a real PDF: pdftoppm cannot render it, so the route must report 422
    await handler(fakeReq({ method: 'POST', headers: { ...SAME_ORIGIN }, body: '%PDF-1.4 broken' }), res)
    assert.equal(res.status, 422)
  })
})

describe('POST /bench (#232)', async () => {
  it('probes a failing channel without network and reports it', async () => {
    const { ctx } = await setupWithAttachment({
      config: { channels: [{ type: 'webhook' }] },
    })
    const handler = ctx.routes.get('/dsh-vision-bridge/bench').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: SAME_ORIGIN }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.channels.length, 1)
    assert.equal(body.channels[0].ok, false, 'webhook without baseURL must fail')
    assert.equal(body.channels[0].okCount, 0)
    assert.ok(body.channels[0].key.startsWith('webhook:'))
  })
})

describe('/batch flow (#227/#232)', async () => {
  it('runs a batch to completion, exposes state via GET, then releases it', async () => {
    const { ctx } = await setupWithAttachment({
      config: { channels: [{ type: 'webhook' }] },
    })
    const handler = ctx.routes.get('/dsh-vision-bridge/batch').handler
    const start = fakeRes()
    await handler(fakeReq({
      method: 'POST',
      headers: SAME_ORIGIN,
      url: '/dsh-vision-bridge/batch',
      body: JSON.stringify({ attachmentIds: ['att-1'], prompt: 'describe' }),
    }), start)
    assert.equal(start.status, 200)
    const bid = JSON.parse(start.body).id

    // the batch runs asynchronously — poll until it finishes (bounded)
    let state = null
    for (let i = 0; i < 20; i++) {
      const poll = fakeRes()
      await handler(fakeReq({ method: 'GET', url: '/dsh-vision-bridge/batch/' + bid }), poll)
      state = JSON.parse(poll.body)
      if (state.finished) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(state, 'batch state reachable')
    assert.equal(state.total, 1)
    assert.equal(state.finished, true, 'a no-network channel batch finishes immediately')
    // channelFailureMode=placeholder: the failed channel yields a placeholder
    // description instead of failing the item.
    assert.equal(state.ok, 1)
    assert.equal(state.failed, 0)
    assert.match(state.results[0].description, /image description unavailable/)
  })

  it('cancel of an unknown batch id is 404', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/batch').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: SAME_ORIGIN, url: '/dsh-vision-bridge/batch/nope/cancel' }), res)
    assert.equal(res.status, 404)
  })
})

describe('POST /test (#232)', async () => {
  it('returns ok with the mock vision answer on the legacy path', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/test').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: SAME_ORIGIN }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.text, 'MOCK DESCRIPTION')
  })
})

describe('#231 journal channel labels', async () => {
  const journalBody = async (ctx) => {
    const handler = ctx.routes.get('/dsh-vision-bridge/journal').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    return JSON.parse(res.body)
  }

  it('legacy-path successes are labeled with the dsh-catalog key format', async () => {
    const { ctx } = await setupWithAttachment({ config: { auditLog: 'all' } })
    const tool = ctx.toolDefs.get('describe_image')
    await tool.execute({ attachmentIds: ['att-1'], question: 'describe this image' }, undefined)
    const body = await journalBody(ctx)
    assert.ok(body.size >= 1, 'a legacy-path call must be journaled when auditLog=all')
    assert.match(body.entries[0].channel, /^dsh-catalog:/)
  })

  it('channels-path failures are journaled under their channel key', async () => {
    const { ctx } = await setupWithAttachment({
      config: { auditLog: 'all', channels: [{ type: 'webhook' }] },
    })
    const tool = ctx.toolDefs.get('describe_image')
    await tool.execute({ attachmentIds: ['att-1'], question: 'describe this image' }, undefined)
    const body = await journalBody(ctx)
    assert.ok(body.size >= 1, 'a failed channels-path call must be journaled')
    assert.equal(body.entries[0].ok, false)
    // known gap (#231 follow-up): when EVERY channel fails the entry is
    // labeled 'all' — the attempts trace is not journaled yet.
    assert.equal(body.entries[0].channel, 'all')
  })
})
