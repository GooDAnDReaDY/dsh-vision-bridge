// Executable smoke tests over apply() with a mock context (#205).
// Every fix of batch 1 ships with a regression test here:
//   #197 describe_image non-empty description (red on v0.5.13..v0.5.29 code)
//   #198 scaleBbox axis-correct bbox scaling (replaces the TDZ expression)
//   #199 bits64ToHex exact 64-bit packing for the pHash cache
//   #204 channelKey distinguishes vllm/sglang endpoints
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment, fakeRes, fakeReq } from './harness.js'

describe('tools smoke — apply() registers a healthy tool surface (#205)', async () => {
  const { ctx } = await setupWithAttachment()

  it('registers 30+ tools with executable contracts', () => {
    assert.ok(ctx.toolNames.length >= 30, 'expected 30+ tools, got ' + ctx.toolNames.length)
    for (const [name, def] of ctx.toolDefs) {
      assert.equal(typeof def.execute, 'function', name + '.execute must be a function')
      assert.ok(typeof def.description === 'string' && def.description.length > 10, name + '.description')
      assert.ok(def.parameters && typeof def.parameters === 'object', name + '.parameters')
    }
  })

  it('registers no duplicate tool names', () => {
    assert.equal(ctx.toolNames.length, ctx.toolDefs.size)
  })

  it('registers the batch-1 web routes', () => {
    for (const p of ['/dsh-vision-bridge/config', '/dsh-vision-bridge/channels', '/dsh-vision-bridge/test', '/dsh-vision-bridge/doctor']) {
      assert.ok(ctx.routes.has(p), 'missing route ' + p)
    }
  })
})

describe('#197 describe_image returns the vision answer (regression)', async () => {
  it('returns a non-empty description with provider/model metadata', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('describe_image')
    const res = await tool.execute({ attachmentIds: ['att-1'], question: 'describe this image' }, undefined)
    assert.equal(typeof res.description, 'string')
    assert.ok(res.description.trim().length > 0, 'description must be non-empty (lastEntry regression #197)')
    assert.equal(res.provider, 'prov')
    assert.equal(res.model, 'm1')
    assert.equal(res.cached, false)
  })

  it('second identical call is served from the cache', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('describe_image')
    const first = await tool.execute({ attachmentIds: ['att-1'], question: 'describe this image' }, undefined)
    const second = await tool.execute({ attachmentIds: ['att-1'], question: 'describe this image' }, undefined)
    assert.equal(second.description, first.description)
    assert.equal(second.cached, true)
  })
})

describe('routes contract over mock req/res (#205)', async () => {
  const { ctx } = await setupWithAttachment()

  it('GET /config returns defaults without network', async () => {
    const handler = ctx.routes.get('/dsh-vision-bridge/config').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.mode, 'hybrid')
    assert.equal(body.describeStrategy, 'auto')
    assert.equal(body.channelFallback, 'sequential')
  })

  it('POST /config rejects an unknown mode with 400', async () => {
    const handler = ctx.routes.get('/dsh-vision-bridge/config').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body: '{"mode":"bogus"}' }), res)
    assert.equal(res.status, 400)
    assert.ok(JSON.parse(res.body).error.includes('mode'))
  })

  it('POST /config from a cross-site origin is forbidden', async () => {
    const handler = ctx.routes.get('/dsh-vision-bridge/config').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{"mode":"llm"}' }), res)
    assert.equal(res.status, 403)
  })

  it('POST /test from a cross-site origin is forbidden', async () => {
    const handler = ctx.routes.get('/dsh-vision-bridge/test').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }), res)
    assert.equal(res.status, 403)
  })
})

describe('#198 scaleBbox — axis-correct bbox scaling', async () => {
  const mod = await import('../lib/index.js')

  it('scales x by width and y by height independently', () => {
    assert.deepEqual(mod.scaleBbox([100, 500, 300, 900], 2000, 1000), [200, 500, 600, 900])
    assert.deepEqual(mod.scaleBbox([0, 0, 1000, 1000], 640, 480), [0, 0, 640, 480])
  })

  it('clamps to the image and keeps x1<=x2 / y1<=y2', () => {
    assert.deepEqual(mod.scaleBbox([1100, -50, 300, 900], 1000, 1000), [300, 0, 1000, 900])
  })

  it('returns [] for malformed bbox', () => {
    assert.deepEqual(mod.scaleBbox([1, 2], 100, 100), [])
    assert.deepEqual(mod.scaleBbox('nope', 100, 100), [])
  })

  it('never divides by a non-positive dimension', () => {
    assert.deepEqual(mod.scaleBbox([100, 100, 200, 200], 0, 0), [100, 100, 200, 200])
  })
})

describe('#199 pHash packing — exact 64-bit hex', async () => {
  const mod = await import('../lib/index.js')

  it('encodes two bits strings differing in bit 0 differently (old parseInt collided)', () => {
    const a = '1' + '0'.repeat(63)
    const b = '1' + '0'.repeat(62) + '1'
    assert.notEqual(mod.bits64ToHex(a), mod.bits64ToHex(b))
  })

  it('encodes every bit: hi/lo halves survive a round trip', () => {
    for (const bits of ['0'.repeat(64), '1'.repeat(64), '0'.repeat(31) + '1' + '0'.repeat(32), '0'.repeat(63) + '1']) {
      const hex = mod.bits64ToHex(bits)
      assert.equal(hex.length, 16)
      const back = BigInt('0x' + hex).toString(2).padStart(64, '0')
      assert.equal(back, bits)
    }
  })

  it('20000 random bit strings encode without collisions', () => {
    const seen = new Set()
    for (let i = 0; i < 20000; i++) {
      let bits = ''
      for (let j = 0; j < 64; j++) bits += Math.random() < 0.5 ? '0' : '1'
      const hex = mod.bits64ToHex(bits)
      assert.ok(!seen.has(hex), 'collision at iteration ' + i)
      seen.add(hex)
    }
    assert.equal(seen.size, 20000)
  })
})

describe('#204 channelKey distinguishes vllm/sglang endpoints', async () => {
  const { channelKey } = await import('../lib/channels.js')

  it('includes baseURL and model for vllm and sglang', () => {
    const a = channelKey({ type: 'vllm', baseURL: 'http://a:8000/v1', model: 'llava' })
    const b = channelKey({ type: 'vllm', baseURL: 'http://b:8000/v1', model: 'llava' })
    const s = channelKey({ type: 'sglang', baseURL: 'http://a:8000/v1', model: 'llava' })
    assert.ok(a.startsWith('vllm:http://a:8000/v1/'))
    assert.notEqual(a, b, 'different baseURLs must not share a key')
    assert.notEqual(a, s, 'vllm and sglang must not share a key')
  })

  it('keeps the established key format for pre-existing channel types', () => {
    assert.equal(channelKey({ type: 'dsh-catalog', provider: 'p', model: 'm' }), 'dsh-catalog:p/m')
    assert.equal(channelKey({ type: 'ollama', model: 'llava' }), 'ollama:http://localhost:11434/v1/llava')
    assert.equal(channelKey({ type: 'openai-compatible', baseURL: 'http://x/v1', model: 'm' }), 'openai-compatible:http://x/v1/m')
    assert.equal(channelKey({ type: 'custom', baseURL: 'http://x', model: 'm' }), 'custom:http://x/m')
    assert.equal(channelKey({ type: 'webhook', url: 'http://hook' }), 'webhook:http://hook')
  })
})

describe('harness sanity — apply() effects and listeners behave like production', async () => {
  it('modality bridge is active and the backstop rewrote the image block', async () => {
    const { ctx } = await setupWithAttachment()
    const info = await ctx.llm.resolveModelInfo('prov', 'm1')
    assert.deepEqual(info._nativeInputModalities, ['text'])
    assert.ok(info.inputModalities.includes('image'))
    assert.ok(ctx.streams.length >= 2, 'inner vision call + re-dispatch expected')
    const redispatch = ctx.streams[ctx.streams.length - 1]
    assert.ok(redispatch.messages[0].content[0].type === 'text', 'image block must be rewritten to text')
    assert.ok(redispatch.messages[0].content[0].text.includes('[The user attached an image'))
  })
})
