// #239: in tools mode no rewrite runs, but attachments must still be indexed
// so the model can call the vision tools with attachment ids from the chat.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment } from './harness.js'

/** Drive every registered agent/pre-step listener as the core waterfall does. */
async function runPreStep(ctx, messages) {
  const listeners = ctx.listeners.get('agent/pre-step') || []
  const base = { messages, kind: 'accept' }
  let index = 0
  const next = async () => (index < listeners.length ? listeners[index++]({ agent: undefined, messages, signal: undefined }, next) : base)
  return next()
}

const IMAGE_MESSAGE = {
  role: 'user',
  content: [{ type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png' } }],
}

describe('#239 tools mode still indexes chat attachments', async () => {
  it('describe_image works by attachmentId when mode=tools', async () => {
    const { ctx } = await setupWithAttachment({ config: { mode: 'tools' } })
    // tools mode skips the llm/stream backstop, so the pre-step is the only
    // place that can record the attachment reference
    await runPreStep(ctx, [IMAGE_MESSAGE])
    const tool = ctx.toolDefs.get('describe_image')
    const res = await tool.execute({ attachmentIds: ['att-1'], question: 'describe this image' }, undefined)
    assert.ok(typeof res.description === 'string' && res.description.trim().length > 0,
      'the attachment id must resolve in tools mode')
  })

  it('paths/urls sources are unaffected', async () => {
    const { ctx } = await setupWithAttachment({ config: { mode: 'tools' } })
    await runPreStep(ctx, [IMAGE_MESSAGE])
    const tool = ctx.toolDefs.get('describe_image')
    // unknown id still fails loudly — indexing must not silently accept anything
    await assert.rejects(
      () => tool.execute({ attachmentIds: ['nope'], question: 'describe' }, undefined),
      /unknown attachment id/,
    )
  })
})
