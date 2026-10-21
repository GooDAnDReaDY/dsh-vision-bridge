import test from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment, fakeReq, fakeRes } from './harness.js'

test('circuit breaker & latency state persistence across calls (#388)', async (t) => {
  const dummyBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const channel = {
    type: 'openai-compatible',
    baseURL: 'https://circuit-fail.invalid/v1',
    model: 'model-a',
    apiKey: 'test-key',
  }

  const route = async (ctx, url, method = 'GET', body = null) => {
    const res = fakeRes()
    const path = url.split('?')[0]
    const handler = ctx.routes.get(path)?.handler
    assert.ok(handler, `route ${path} not found`)
    await handler(fakeReq({ url, method, body: body ? JSON.stringify(body) : '' }), res)
    return { status: res.status, body: JSON.parse(res.body || '{}') }
  }

  await t.test('3 failures open the circuit and state is preserved in /dsh-vision-bridge/circuit', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => new Response('Internal Server Error', { status: 500 })

      const { ctx } = await setupWithAttachment({
        imageBytes: dummyBytes,
        config: {
          channels: [channel],
          channelCooldownMs: 0,
          channelFailureMode: 'error',
          mode: 'hybrid',
        },
      })

      const tool = ctx.toolDefs.get('vision_inspect')
      assert.ok(tool)

      // Trigger 3 consecutive failures
      for (let i = 0; i < 3; i++) {
        await assert.rejects(async () => {
          await tool.execute({ source: 'att-1', prompt: 'test ' + i })
        }, /dsh-vision-bridge:/)
      }

      // Check /circuit endpoint — should now have recorded the open circuit
      const status = await route(ctx, '/dsh-vision-bridge/circuit')
      assert.equal(status.status, 200)
      const chKey = 'openai-compatible:https://circuit-fail.invalid/v1/model-a'
      assert.ok(status.body.circuits[chKey], 'Circuit state for channel must exist')
      assert.equal(status.body.circuits[chKey].state, 'open')
      assert.equal(status.body.circuits[chKey].failures, 3)
      assert.ok(status.body.circuits[chKey].openUntil > Date.now())

      // 4th call should immediately fail due to open circuit without even calling fetch
      let fetchCalled = false
      globalThis.fetch = async () => {
        fetchCalled = true
        return new Response('should not be called', { status: 500 })
      }

      await assert.rejects(async () => {
        await tool.execute({ source: 'att-1', prompt: 'test 4' })
      }, /dsh-vision-bridge:/)

      assert.equal(fetchCalled, false, 'Open circuit breaker must skip channel execution')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await t.test('success resets circuit breaker state', async () => {
    const originalFetch = globalThis.fetch
    try {
      let succeed = false
      globalThis.fetch = async () => {
        if (!succeed) return new Response('error', { status: 500 })
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'recovered answer' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }

      const { ctx } = await setupWithAttachment({
        imageBytes: dummyBytes,
        config: {
          channels: [channel],
          channelCooldownMs: 0,
          channelFailureMode: 'error',
          mode: 'hybrid',
        },
      })

      const tool = ctx.toolDefs.get('vision_inspect')

      // Trigger 1 failure
      await assert.rejects(async () => {
        await tool.execute({ source: 'att-1', prompt: 'fail once' })
      })

      let status = await route(ctx, '/dsh-vision-bridge/circuit')
      const chKey = 'openai-compatible:https://circuit-fail.invalid/v1/model-a'
      assert.ok(status.body.circuits[chKey]?.failures >= 1)

      // Now succeed
      succeed = true
      const okRes = await tool.execute({ source: 'att-1', prompt: 'succeed now' })
      assert.equal(okRes.result, 'recovered answer')

      // Check circuit state reset
      status = await route(ctx, '/dsh-vision-bridge/circuit')
      assert.equal(status.body.circuits[chKey]?.failures, 0)
      assert.equal(status.body.circuits[chKey]?.state, 'closed')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

