import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment } from './harness.js'

describe('Issue #377 & #378: Cache Identity and Null Safety', () => {
  it('Issue #378: cacheEnabled=false with configured channels does not throw null.has or null.set', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'channel vision answer' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const { ctx } = await setupWithAttachment({
        config: {
          cacheEnabled: false,
          channels: [{
            type: 'openai-compatible',
            baseURL: 'https://fake.openai.com/v1',
            model: 'gpt-4o-mini',
            apiKey: 'test-key',
          }],
        },
      })

      const tool = ctx.toolDefs.get('vision_inspect')
      // Must not throw Cannot read properties of null (reading 'has')
      const res = await tool.execute({ source: 'att-1', prompt: 'describe this' }, undefined)
      assert.ok(res)
      assert.equal(res.cached, false)
      assert.equal(res.result, 'channel vision answer')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('Issue #377: pHash cache differentiates tasks and questions on the same image', async () => {
    let callCount = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_url, opts) => {
      callCount++
      const body = JSON.parse(opts.body)
      const userContent = body.messages?.[0]?.content
      let prompt = ''
      if (Array.isArray(userContent)) {
        const textPart = userContent.find(p => p.type === 'text')
        prompt = textPart ? textPart.text : ''
      }
      const answer = prompt.includes('heading') ? 'Answer: Heading Title' : 'Answer: Total $100'
      return new Response(JSON.stringify({
        choices: [{ message: { content: answer } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const { ctx } = await setupWithAttachment({
        config: {
          cacheEnabled: true,
          channels: [{
            type: 'openai-compatible',
            baseURL: 'https://fake.openai.com/v1',
            model: 'gpt-4o-mini',
            apiKey: 'test-key',
          }],
        },
      })

      // Reset call count after setupWithAttachment initial backstop drain
      callCount = 0

      const tool = ctx.toolDefs.get('vision_inspect')

      // Call 1: Question about heading
      const res1 = await tool.execute({ source: 'att-1', prompt: 'What is the heading?' }, undefined)
      assert.equal(res1.result, 'Answer: Heading Title')
      assert.equal(res1.cached, false)
      assert.equal(callCount, 1)

      // Call 2: Question about amount on same image — must NOT hit cache from Call 1
      const res2 = await tool.execute({ source: 'att-1', prompt: 'What is the amount?' }, undefined)
      assert.equal(res2.result, 'Answer: Total $100')
      assert.equal(res2.cached, false)
      assert.equal(callCount, 2)

      // Call 3: Repeat Call 1 — MUST hit cache
      const res3 = await tool.execute({ source: 'att-1', prompt: 'What is the heading?' }, undefined)
      assert.equal(res3.result, 'Answer: Heading Title')
      assert.equal(res3.cached, true)
      assert.equal(callCount, 2) // Served from cache, no new fetch call

      // Call 4: Different mode (e.g. ocr) on same image — must NOT hit describe cache
      const res4 = await tool.execute({ source: 'att-1', mode: 'ocr', prompt: 'What is the heading?' }, undefined)
      assert.equal(res4.cached, false)
      assert.equal(callCount, 3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
