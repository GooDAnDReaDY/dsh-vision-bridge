import test from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment, fakeReq, fakeRes } from './harness.js'

test('vision_batch cancellation and cleanup (#397)', async (t) => {
  const dummyBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const channel = {
    type: 'openai-compatible',
    baseURL: 'https://batch-test.invalid/v1',
    model: 'model-a',
    apiKey: 'test-key',
  }

  const route = async (ctx, url, method = 'GET', body = null) => {
    const res = fakeRes()
    const path = url.split('?')[0].startsWith('/dsh-vision-bridge/batch/')
      ? '/dsh-vision-bridge/batch'
      : url.split('?')[0]
    const handler = ctx.routes.get(path)?.handler
    assert.ok(handler, `route ${path} not found`)
    await handler(fakeReq({ url, method, body: body ? JSON.stringify(body) : '' }), res)
    return { status: res.status, body: JSON.parse(res.body || '{}') }
  }

  await t.test('aborted execution signal aborts immediately before launching work', async () => {
    const { ctx } = await setupWithAttachment({
      imageBytes: dummyBytes,
      config: {
        channels: [channel],
        mode: 'hybrid',
      },
    })

    const tool = ctx.toolDefs.get('vision_batch')
    assert.ok(tool)

    const ctrl = new AbortController()
    ctrl.abort()

    await assert.rejects(
      async () => {
        await tool.execute({ attachmentIds: ['att-1'], prompt: 'describe' }, { signal: ctrl.signal })
      },
      /operation aborted/
    )
  })

  await t.test('DELETE on active batch aborts provider request and batch controller', async () => {
    let release, capturedSignal
    const originalFetch = globalThis.fetch
    try {
      // First call during setup succeeds
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'setup answer' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })

      const { ctx } = await setupWithAttachment({
        imageBytes: dummyBytes,
        config: {
          channels: [channel],
          mode: 'hybrid',
        },
      })

      // Next call hangs until release
      globalThis.fetch = async (_u, opts) => {
        capturedSignal = opts.signal
        await new Promise((r) => { release = r })
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'batch answer' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }

      const started = await route(ctx, '/dsh-vision-bridge/batch', 'POST', {
        attachmentIds: ['att-1'],
        prompt: 'test batch',
      })
      assert.equal(started.status, 200)
      const bid = started.body.id
      assert.ok(bid)

      // Wait until fetch starts and capturedSignal is assigned
      for (let i = 0; i < 50 && !release; i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.ok(release, 'Provider fetch must be reached')
      assert.equal(capturedSignal.aborted, false)

      // DELETE the running batch
      const removed = await route(ctx, '/dsh-vision-bridge/batch/' + bid, 'DELETE')
      assert.equal(removed.status, 200)
      assert.equal(removed.body.released, true)

      // Signal must now be aborted
      assert.equal(capturedSignal.aborted, true, 'Provider signal must be aborted on DELETE')

      // Clean up hanging promise
      release()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

