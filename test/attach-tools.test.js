// #241: attach-domain tools — registration, limit math and the fetch policy
// they inherit. External binaries (pdftoppm/ffmpeg) are not required by these
// tests; only the deterministic parts are exercised.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment, fakeAgent } from './harness.js'
import { trimToLimit, ATTACH_HARD_CAP } from '../lib/tools/attach.js'

async function runPreStep(ctx, agent) {
  const listeners = ctx.listeners.get('agent/pre-step') || []
  const base = { messages: [], kind: 'accept' }
  let index = 0
  const next = async () => (index < listeners.length ? listeners[index++]({ agent, messages: [], signal: undefined }, next) : base)
  return next()
}

describe('#241 attach tools are registered', async () => {
  const { ctx } = await setupWithAttachment()

  it('exposes the three attach tools with honest descriptions', () => {
    for (const name of ['vision_attach_pages', 'vision_attach_frames', 'vision_attach_images']) {
      const tool = ctx.toolDefs.get(name)
      assert.ok(tool, name + ' must be registered')
      assert.equal(typeof tool.execute, 'function')
      assert.ok(tool.description.length > 30, name + ' description')
    }
  })

  it('render produces a text block even with no items', () => {
    const tool = ctx.toolDefs.get('vision_attach_images')
    const blocks = tool.output.render({}, { items: [], note: 'nothing' })
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[0].text, 'nothing')
  })

  it('requires at least one source', async () => {
    const tool = ctx.toolDefs.get('vision_attach_images')
    await assert.rejects(() => tool.execute({}, undefined), /pass paths, dirs or urls/)
  })

  it('refuses a URL outside the fetch policy before any request', async () => {
    const tool = ctx.toolDefs.get('vision_attach_images')
    await assert.rejects(
      () => tool.execute({ urls: ['http://127.0.0.1:9/x.png'] }, undefined),
      /refused by fetch policy/,
    )
  })
})

describe('#241 attach limit math', () => {
  it('keeps the configured number of items and reports truncation', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ name: 'i' + i }))
    assert.deepEqual(trimToLimit(items, 8), { kept: items.slice(0, 8), truncated: true, cap: 8 })
    assert.deepEqual(trimToLimit(items.slice(0, 3), 8), { kept: items.slice(0, 3), truncated: false, cap: 8 })
  })

  it('falls back to 8 and never exceeds the hard cap', () => {
    assert.equal(trimToLimit([], undefined).cap, 8)
    assert.equal(trimToLimit([], 0).cap, 8)
    assert.equal(trimToLimit([], 999).cap, ATTACH_HARD_CAP)
    assert.equal(trimToLimit([], 1).cap, 1)
  })

  it('tolerates a non-array input', () => {
    assert.deepEqual(trimToLimit(null, 4).kept, [])
  })
})

describe('#241 mirrored tool policy', async () => {
  it('a text-only route hides the attach tools and keeps the compensation set', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: { inputModalities: ['text'] } })
    const { agent, restricted } = fakeAgent({ provider: 'p', model: 'text-model' })
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 1)
    const deny = restricted[0].deny
    assert.ok(deny.includes('vision_attach_pages'))
    assert.equal(deny.includes('describe_image'), false, 'compensation tools are the text-only model’s only sight')
  })
})
