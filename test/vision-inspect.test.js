// Tests for unified meta-tool vision_inspect
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment } from './harness.js'

describe('vision_inspect unified meta-tool', async () => {
  it('registers vision_inspect tool in tool registry', async () => {
    const { ctx } = await setupWithAttachment()
    assert.ok(ctx.toolDefs.has('vision_inspect'), 'vision_inspect must be registered')
  })

  it('executes describe mode by default with attachmentId', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('vision_inspect')
    const res = await tool.execute({ source: 'att-1', mode: 'describe' }, undefined)
    assert.equal(res.mode, 'describe')
    assert.ok(typeof res.result === 'string')
    assert.match(res.result, /MOCK DESCRIPTION/)
  })

  it('executes ocr mode with appropriate prompt', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('vision_inspect')
    const res = await tool.execute({ source: 'att-1', mode: 'ocr', prompt: 'invoice total' }, undefined)
    assert.equal(res.mode, 'ocr')
    assert.ok(res.result)
  })

  it('executes detect_ui mode', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('vision_inspect')
    const res = await tool.execute({ source: 'att-1', mode: 'detect_ui' }, undefined)
    assert.equal(res.mode, 'detect_ui')
    assert.ok(res.result)
  })

  it('executes extract_data mode with schema', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('vision_inspect')
    const schema = { type: 'object', properties: { title: { type: 'string' }, amount: { type: 'number' } } }
    const res = await tool.execute({ source: 'att-1', mode: 'extract_data', schema }, undefined)
    assert.equal(res.mode, 'extract_data')
    assert.ok(res.result)
  })

  it('falls back to the last attachment when source is omitted', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('vision_inspect')
    const res = await tool.execute({ mode: 'describe' }, undefined)
    assert.equal(res.mode, 'describe')
    assert.ok(res.result)
  })
})
