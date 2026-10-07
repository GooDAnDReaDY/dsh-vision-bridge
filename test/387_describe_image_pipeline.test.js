import test from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment, fakeReq, fakeRes } from './harness.js'

test('describe_image & vqa pipeline routing (#387)', async (t) => {
  const dummyBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const channel = {
    type: 'openai-compatible',
    baseURL: 'https://audit.invalid/v1',
    model: 'audit-model',
    apiKey: 'audit-synthetic-key',
  }

  await t.test('describe_image with attachment routes through configured channels for non-generic question', async () => {
    let httpCalls = 0
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async (_url, opts) => {
        httpCalls++
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'channel non-generic answer' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }

      const { ctx } = await setupWithAttachment({
        imageBytes: dummyBytes,
        config: {
          channels: [channel],
          mode: 'hybrid',
        },
      })
      ctx.streams.length = 0

      const tool = ctx.toolDefs.get('describe_image')
      assert.ok(tool)
      const res = await tool.execute({ attachmentIds: ['att-1'], question: 'q' })

      assert.ok(httpCalls > 0, 'Must route through HTTP channels instead of bypassing')
      assert.equal(ctx.streams.length, 0, 'Must not fall back to direct llm stream when channel succeeds')
      assert.equal(res.description, 'channel non-generic answer')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await t.test('vision_vqa routes through configured channels', async () => {
    let httpCalls = 0
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async (_url, opts) => {
        httpCalls++
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'vqa channel answer' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }

      const { ctx } = await setupWithAttachment({
        imageBytes: dummyBytes,
        config: {
          channels: [channel],
          mode: 'hybrid',
        },
      })
      ctx.streams.length = 0

      const tool = ctx.toolDefs.get('vision_vqa')
      assert.ok(tool)
      const res = await tool.execute({ attachmentId: 'att-1', question: 'What color is the logo?' })

      assert.ok(httpCalls > 0, 'VQA must route through channels')
      assert.equal(ctx.streams.length, 0, 'Must not bypass to direct stream')
      assert.equal(res.answer, 'vqa channel answer')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await t.test('describe_image honors abort signal in execution options', async () => {
    const originalFetch = globalThis.fetch
    try {
      const ctrl = new AbortController()
      ctrl.abort()

      globalThis.fetch = async (_url, opts) => {
        assert.ok(opts.signal.aborted)
        throw new Error('aborted')
      }

      const { ctx } = await setupWithAttachment({
        imageBytes: dummyBytes,
        config: {
          channels: [channel],
          mode: 'hybrid',
          channelFailureMode: 'error',
        },
      })

      const tool = ctx.toolDefs.get('describe_image')
      await assert.rejects(
        async () => {
          await tool.execute({ attachmentIds: ['att-1'], question: 'q' }, { signal: ctrl.signal })
        },
        /dsh-vision-bridge:/
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

