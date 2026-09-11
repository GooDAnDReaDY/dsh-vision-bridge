// #242: model-aware tool exposure — a chat route with native vision must not
// receive the compensation tools; extra instruments stay. The policy is
// verified through the agent/pre-step listener with a fake scoped agent.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment, createMockCtx, fakeAgent } from './harness.js'

/** Drive every registered agent/pre-step listener as the core waterfall does. */
async function runPreStep(ctx, agent) {
  const listeners = ctx.listeners.get('agent/pre-step') || []
  const base = { messages: [], kind: 'accept' }
  let index = 0
  const next = async () => (index < listeners.length ? listeners[index++]({ agent, signal: undefined }, next) : base)
  return next()
}

const VISION_INFO = { inputModalities: ['text', 'image'] }
const TEXT_INFO = { inputModalities: ['text'] }

describe('#242 vision-route hides compensation tools', async () => {
  it('applies a deny restriction listing the compensation tools', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: VISION_INFO })
    const { agent, restricted } = fakeAgent({ provider: 'p', model: 'vision-model' })
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 1, 'restrict must be applied once for a vision route')
    const deny = restricted[0].deny
    assert.ok(Array.isArray(deny))
    for (const name of ['describe_image', 'read_image', 'inspect_image', 'vision_vqa', 'vision_crop']) {
      assert.ok(deny.includes(name), name + ' must be hidden from a vision model')
    }
    assert.equal(deny.includes('vision_pdf_pages'), false, 'media extras stay available')
    assert.equal(deny.includes('vision_memory_search'), false, 'extras stay available')
  })

  it('does not restrict a text-only route', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: TEXT_INFO })
    const { agent, restricted } = fakeAgent({ provider: 'p', model: 'text-model' })
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 0)
  })

  it('applies the restriction once per unchanged route', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: VISION_INFO })
    const { agent, restricted } = fakeAgent({ provider: 'p', model: 'vision-model' })
    await runPreStep(ctx, agent)
    await runPreStep(ctx, agent)
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 1, 'the route is cached per agent')
  })

  it('lifts the mask when the route switches to a text-only model', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: VISION_INFO })
    const { agent, restricted, lifted } = fakeAgent({ provider: 'p', model: 'vision-model' })
    await runPreStep(ctx, agent)
    // switch the agent's route and make the catalog text-only
    agent.session.requestHeader = () => ({ config: { provider: 'p', model: 'text-model' } })
    ctx.llm.resolveModelInfo = async (provider, model) => (model === 'text-model' ? TEXT_INFO : VISION_INFO)
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 1)
    assert.equal(lifted.length, 1, 'the previous mask must be lifted on route change')
  })

  it('is disabled by hideRedundantTools=false', async () => {
    const { ctx } = await setupWithAttachment({ config: { hideRedundantTools: false }, modelInfo: VISION_INFO })
    const { agent, restricted } = fakeAgent({ provider: 'p', model: 'vision-model' })
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 0)
  })

  it('degrades safely when the core has no scoped tools.restrict', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: VISION_INFO })
    const { agent } = fakeAgent({ provider: 'p', model: 'vision-model', withRestrict: false })
    await assert.doesNotReject(() => runPreStep(ctx, agent))
  })
})
