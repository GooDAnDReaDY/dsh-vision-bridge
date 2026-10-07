import test from 'node:test'
import assert from 'node:assert/strict'
import { runChannel, runChannels } from '../lib/channels.js'
import { VISION_PASS } from '../lib/vision-core.js'
import { createMockCtx, setupWithAttachment, fakeReq, fakeRes } from './harness.js'
import { apply } from '../lib/index.js'

test('dsh-catalog channel (#386)', async (t) => {
  const dummyBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  await t.test('runChannel returns ok:false with informative reason when host llm is missing', async () => {
    const res = await runChannel({ type: 'dsh-catalog', provider: 'prov', model: 'm1' }, {
      bytes: dummyBytes,
      prompt: 'test prompt',
    })
    assert.equal(res.ok, false)
    assert.match(res.reason, /host llm service is unavailable/)
  })

  await t.test('runChannel dispatches through host llm.stream with VISION_PASS and returns ok:true', async () => {
    let capturedOptions = null
    const mockLlm = {
      async *stream(options) {
        capturedOptions = options
        yield { type: 'text-delta', text: 'Catalog response from ' + options.model }
      },
    }

    const res = await runChannel(
      { type: 'dsh-catalog', provider: 'prov', model: 'm1' },
      {
        bytes: dummyBytes,
        contentType: 'image/png',
        prompt: 'describe this catalog item',
        llm: mockLlm,
      }
    )

    assert.equal(res.ok, true)
    assert.equal(res.description, 'Catalog response from m1')
    assert.equal(res.provider, 'prov')
    assert.equal(res.model, 'm1')
    assert.ok(capturedOptions)
    assert.equal(capturedOptions.provider, 'prov')
    assert.equal(capturedOptions.model, 'm1')
    assert.equal(capturedOptions[VISION_PASS], true)
  })

  await t.test('runChannels routes dsh-catalog in sequential fallback chain', async () => {
    let streamCalled = false
    const mockLlm = {
      async *stream(options) {
        streamCalled = true
        yield { type: 'text-delta', text: 'sequential catalog answer' }
      },
    }

    const channels = [
      { type: 'dsh-catalog', provider: 'host-provider', model: 'host-model' },
    ]

    const res = await runChannels(channels, {
      bytes: dummyBytes,
      contentType: 'image/png',
      prompt: 'test sequential',
      llm: mockLlm,
      fallback: 'sequential',
    })

    assert.equal(res.ok, true)
    assert.equal(res.description, 'sequential catalog answer')
    assert.equal(streamCalled, true)
    assert.equal(res.attempts.length, 1)
    assert.equal(res.attempts[0].ok, true)
  })

  await t.test('host integration: callVisionModelWithBytes dispatches to configured dsh-catalog channel', async () => {
    const { ctx } = await setupWithAttachment({
      imageBytes: dummyBytes,
      config: {
        mode: 'hybrid',
        channels: [
          { type: 'dsh-catalog', provider: 'custom-prov', model: 'custom-model' },
        ],
      },
    })

    let streamedToModel = ''
    ctx.llm.stream = async function* (options) {
      streamedToModel = options.model
      yield { type: 'text-delta', text: 'full host bridge catalog description' }
    }

    const tool = ctx.toolDefs.get('vision_inspect')
    assert.ok(tool)
    const result = await tool.execute({ source: 'att-1', prompt: 'inspect catalog' })

    assert.equal(streamedToModel, 'custom-model')
    assert.equal(result.result, 'full host bridge catalog description')
  })
})

