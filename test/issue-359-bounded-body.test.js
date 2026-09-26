import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setupWithAttachment, fakeRes, fakeReq } from './harness.js'
import { readBoundedBody, MAX_CONFIG_BODY_BYTES, MAX_BATCH_BODY_BYTES } from '../lib/vision-core.js'

describe('Issue #359: bounded body reader with 413 limits', () => {
  it('rejects upfront when declared Content-Length exceeds limit', async () => {
    let chunksEmitted = 0
    const req = new EventEmitter()
    req.headers = { 'content-length': '2000' }
    req.on = (event, cb) => {
      if (event === 'data') chunksEmitted++
      EventEmitter.prototype.on.call(req, event, cb)
    }

    await assert.rejects(
      async () => readBoundedBody(req, 1000),
      (err) => {
        assert.equal(err.statusCode, 413)
        assert.match(err.message, /exceeds the 1000 limit/)
        return true
      }
    )
    assert.equal(chunksEmitted, 0, 'must not consume body if declared length is oversized')
  })

  it('rejects mid-stream when chunked data grows past limit', async () => {
    const req = new EventEmitter()
    req.headers = {} // no Content-Length (chunked)
    let destroyed = false
    req.destroy = () => { destroyed = true }

    const promise = readBoundedBody(req, 100)

    req.emit('data', Buffer.from('x'.repeat(60)))
    req.emit('data', Buffer.from('y'.repeat(60))) // total 120 > 100
    req.emit('end')

    await assert.rejects(
      async () => promise,
      (err) => {
        assert.equal(err.statusCode, 413)
        return true
      }
    )
  })

  it('resolves valid body within limit', async () => {
    const req = new EventEmitter()
    req.headers = { 'content-length': '11' }
    const promise = readBoundedBody(req, 100)

    req.emit('data', Buffer.from('hello '))
    req.emit('data', Buffer.from('world'))
    req.emit('end')

    const res = await promise
    assert.equal(res, 'hello world')
  })

  it('POST /dsh-vision-bridge/config rejects oversized declared body with 413', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/config').handler
    const res = fakeRes()

    const req = fakeReq({
      method: 'POST',
      headers: {
        'content-length': String(MAX_CONFIG_BODY_BYTES + 1024),
        'sec-fetch-site': 'same-origin',
        host: 'localhost:3080'
      },
      socket: { remoteAddress: '127.0.0.1' },
      body: 'x'.repeat(100)
    })

    await handler(req, res)
    assert.equal(res.status, 413)
    const data = JSON.parse(res.body)
    assert.match(data.error, /exceeds/)
  })

  it('POST /dsh-vision-bridge/channels rejects oversized declared body with 413', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/channels').handler
    const res = fakeRes()

    const req = fakeReq({
      method: 'POST',
      headers: {
        'content-length': String(MAX_CONFIG_BODY_BYTES + 500),
        'sec-fetch-site': 'same-origin',
        host: 'localhost:3080'
      },
      socket: { remoteAddress: '127.0.0.1' },
      body: 'x'.repeat(100)
    })

    await handler(req, res)
    assert.equal(res.status, 413)
  })

  it('POST /dsh-vision-bridge/batch rejects oversized body with 413', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/batch').handler
    const res = fakeRes()

    const req = fakeReq({
      method: 'POST',
      url: '/dsh-vision-bridge/batch',
      headers: {
        'content-length': String(MAX_BATCH_BODY_BYTES + 2000),
        'sec-fetch-site': 'same-origin',
        host: 'localhost:3080'
      },
      socket: { remoteAddress: '127.0.0.1' },
      body: 'x'.repeat(100)
    })

    await handler(req, res)
    assert.equal(res.status, 413)
  })
})
