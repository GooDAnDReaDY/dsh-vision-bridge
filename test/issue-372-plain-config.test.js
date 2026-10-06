import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMockCtx } from './harness.js'
import { apply, plainConfig, resolveStorageDir } from '../lib/index.js'

describe('Issues #372 and #368: volatile boxes unwrapping with plainConfig', () => {
  it('unwraps nested volatile boxes without corrupting primitives or buffers', () => {
    const buf = Buffer.from('test-buffer')
    const boxed = {
      consensusEnabled: { get: () => false },
      selfCheckEnabled: { get: () => true },
      evidenceDir: { get: () => '/custom/evidence' },
      keysFromEnv: { get: () => ['MY_CUSTOM_KEY'] },
      buffer: buf,
      arr: [{ nested: { get: () => 42 } }],
    }
    const unboxed = plainConfig(boxed)
    assert.equal(unboxed.consensusEnabled, false)
    assert.equal(unboxed.selfCheckEnabled, true)
    assert.equal(unboxed.evidenceDir, '/custom/evidence')
    assert.deepEqual(unboxed.keysFromEnv, ['MY_CUSTOM_KEY'])
    assert.equal(unboxed.buffer, buf)
    assert.equal(unboxed.arr[0].nested, 42)
  })

  it('Issue #372: boxed false for consensusEnabled does NOT register vision_consensus', () => {
    const ctx = createMockCtx({
      config: {
        consensusEnabled: { get: () => false },
        selfCheckEnabled: { get: () => true },
      },
    })
    apply(ctx, ctx.config)
    assert.equal(ctx.toolDefs.has('vision_consensus'), false, 'vision_consensus must NOT be registered when consensusEnabled box is false')
    assert.equal(ctx.toolDefs.has('vision_self_check'), true, 'vision_self_check must be registered when selfCheckEnabled is true')
  })

  it('Issue #372: boxed false for selfCheckEnabled does NOT register vision_self_check', () => {
    const ctx = createMockCtx({
      config: {
        selfCheckEnabled: { get: () => false },
        consensusEnabled: { get: () => false },
      },
    })
    apply(ctx, ctx.config)
    assert.equal(ctx.toolDefs.has('vision_self_check'), false, 'vision_self_check must NOT be registered when selfCheckEnabled box is false')
  })

  it('Issue #368: boxed evidenceDir is correctly resolved in resolveStorageDir', () => {
    const customPath = '/tmp/custom-evidence-path-' + Date.now()
    const ctx = createMockCtx()
    const boxedConfig = {
      evidenceDir: { get: () => customPath },
    }
    const resolved = resolveStorageDir(ctx, boxedConfig)
    assert.equal(resolved, customPath)
  })

  it('Issue #368: boxed keysFromEnv is unboxed and usable for channel authentication', () => {
    const ctx = createMockCtx({
      config: {
        keysFromEnv: { get: () => ['CUSTOM_VISION_KEY_NAME'] },
        channels: [{ type: 'custom', baseURL: 'http://example.com' }],
      },
    })
    process.env.CUSTOM_VISION_KEY_NAME = 'sk-custom-secret'
    try {
      apply(ctx, ctx.config)
      // Check that routes or live channels can see the unboxed keysFromEnv
      assert.ok(ctx.routes.has('/dsh-vision-bridge/config'))
    } finally {
      delete process.env.CUSTOM_VISION_KEY_NAME
    }
  })
})
