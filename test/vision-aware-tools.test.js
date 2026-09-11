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

  it('a text-only route hides the attach tools instead of the compensation set', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: TEXT_INFO })
    const { agent, restricted } = fakeAgent({ provider: 'p', model: 'text-model' })
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 1)
    assert.ok(restricted[0].deny.includes('vision_attach_images'))
    assert.equal(restricted[0].deny.includes('describe_image'), false)
  })

  it('applies the restriction once per unchanged route', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: VISION_INFO })
    const { agent, restricted } = fakeAgent({ provider: 'p', model: 'vision-model' })
    await runPreStep(ctx, agent)
    await runPreStep(ctx, agent)
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 1, 'the route is cached per agent')
  })

  it('swaps the mask when the route switches to a text-only model', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: VISION_INFO })
    const { agent, restricted, lifted } = fakeAgent({ provider: 'p', model: 'vision-model' })
    await runPreStep(ctx, agent)
    // switch the agent's route and make the catalog text-only
    agent.session.requestHeader = () => ({ config: { provider: 'p', model: 'text-model' } })
    ctx.llm.resolveModelInfo = async (provider, model) => (model === 'text-model' ? TEXT_INFO : VISION_INFO)
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 2, 'the new route gets its own mask')
    assert.equal(lifted.length, 1, 'the previous mask must be lifted on route change')
    assert.ok(restricted[1].deny.includes('vision_attach_pages'))
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

describe('#242 review follow-ups', async () => {
  it('the deny list never contains an extra instrument', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: VISION_INFO })
    const { agent, restricted } = fakeAgent({ provider: 'p', model: 'vision-model' })
    await runPreStep(ctx, agent)
    const deny = new Set(restricted[0].deny)
    const extras = ['vision_pdf_pages', 'vision_video_describe', 'vision_html_screenshot', 'vision_page_persist',
      'vision_browser_snapshot', 'vision_batch', 'vision_materialize', 'vision_present', 'vision_export_report',
      'vision_memory_search', 'vision_verify_generated_image', 'vision_consensus', 'vision_ocr_local',
      'vision_long_ocr', 'vision_compare']
    for (const name of extras) assert.equal(deny.has(name), false, name + ' is an extra and must stay visible')
  })

  it('a route switching from text-only to vision swaps the mask', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: TEXT_INFO })
    const { agent, restricted } = fakeAgent({ provider: 'p', model: 'text-model' })
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 1)
    assert.ok(restricted[0].deny.includes('vision_attach_images'), 'text-only hides the attach tools')
    agent.session.requestHeader = () => ({ config: { provider: 'p', model: 'vision-model' } })
    ctx.llm.resolveModelInfo = async (provider, model) => (model === 'vision-model' ? VISION_INFO : TEXT_INFO)
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 2, 'the vision route gets its own mask')
    assert.ok(restricted[1].deny.includes('describe_image'))
    assert.equal(restricted[1].deny.includes('vision_attach_images'), false)
  })

  it('turning hideRedundantTools off at runtime lifts the mask', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: VISION_INFO })
    const { agent, lifted } = fakeAgent({ provider: 'p', model: 'vision-model' })
    await runPreStep(ctx, agent)
    ctx.config.hideRedundantTools = false
    await runPreStep(ctx, agent)
    assert.equal(lifted.length, 1, 'the mask must be lifted when the behavior is disabled')
  })
})

describe('#242 follow-up: forced bridging keeps the tools', async () => {
  it("nativePassthrough='never' keeps the compensation tools (bridge is forced)", async () => {
    const { ctx } = await setupWithAttachment({ config: { nativePassthrough: 'never' }, modelInfo: VISION_INFO })
    const { agent, restricted } = fakeAgent({ provider: 'p', model: 'vision-model' })
    await runPreStep(ctx, agent)
    const deny = restricted[0].deny
    assert.equal(deny.includes('describe_image'), false, 'forced bridging keeps the compensation tools available')
    assert.ok(deny.includes('vision_attach_images'), 'but attach tools are redundant while the bridge describes images')
  })

  it("nativePassthrough='always' masks a vision route (bridge never runs)", async () => {
    const { ctx } = await setupWithAttachment({ config: { nativePassthrough: 'always' }, modelInfo: VISION_INFO })
    const { agent, restricted } = fakeAgent({ provider: 'p', model: 'vision-model' })
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 1)
  })
  it('a runtime nativePassthrough change re-evaluates the mask on the same route', async () => {
    const { ctx } = await setupWithAttachment({ config: {}, modelInfo: VISION_INFO })
    const { agent, restricted, lifted } = fakeAgent({ provider: 'p', model: 'vision-model' })
    await runPreStep(ctx, agent)
    assert.equal(restricted.length, 1)
    ctx.config.nativePassthrough = 'never' // same route, bridge forced
    await runPreStep(ctx, agent)
    assert.equal(lifted.length, 1, 'the stale mask must be lifted when the policy changes')
    assert.equal(restricted.length, 2, 'the forced-bridge route gets the mirrored mask')
    assert.ok(restricted[1].deny.includes('vision_attach_images'))
    assert.equal(restricted[1].deny.includes('describe_image'), false)
  })
})
