import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveApiKeys, resolveApiKey, runChannel } from '../lib/channels.js'
import { resolveChannelApiKey } from '../lib/vision-core.js'

describe('Issue #382: Channel Env Keys Resolution', () => {
  it('resolveApiKeys respects empty or custom keysFromEnv', () => {
    const origEnv = process.env.OPENAI_API_KEY
    try {
      process.env.OPENAI_API_KEY = 'sk-unauthorized-env-key'

      // When keysFromEnv is empty array, it must NOT pick up OPENAI_API_KEY
      const emptyKeys = resolveApiKeys({ type: 'openai-compatible' }, [])
      assert.deepEqual(emptyKeys, [])

      // When keysFromEnv allows only a specific key
      process.env.CUSTOM_VISION_KEY = 'sk-custom-allowed'
      const customKeys = resolveApiKeys({ type: 'openai-compatible' }, ['CUSTOM_VISION_KEY'])
      assert.deepEqual(customKeys, ['sk-custom-allowed'])
    } finally {
      if (origEnv !== undefined) process.env.OPENAI_API_KEY = origEnv
      else delete process.env.OPENAI_API_KEY
      delete process.env.CUSTOM_VISION_KEY
    }
  })

  it('resolveChannelApiKey restricts env fallback to allowedEnvNames', async () => {
    const fakeEnv = {
      UNAUTHORIZED_KEY: 'secret-unauthorized',
      AUTHORIZED_KEY: 'secret-authorized',
    }

    // Blocked by allowedEnvNames
    const chanBlocked = { type: 'openai-compatible', apiKeyRef: 'UNAUTHORIZED_KEY' }
    const resolvedBlocked = await resolveChannelApiKey(chanBlocked, null, fakeEnv, ['AUTHORIZED_KEY'])
    assert.equal(resolvedBlocked.apiKey, undefined)

    // Allowed by allowedEnvNames
    const chanAllowed = { type: 'openai-compatible', apiKeyRef: 'AUTHORIZED_KEY' }
    const resolvedAllowed = await resolveChannelApiKey(chanAllowed, null, fakeEnv, ['AUTHORIZED_KEY'])
    assert.equal(resolvedAllowed.apiKey, 'secret-authorized')
  })

  it('runChannel passes keysFromEnv to avoid leaking unauthorized env credentials', async () => {
    const origEnv = process.env.OPENAI_API_KEY
    try {
      process.env.OPENAI_API_KEY = 'sk-leak-test'

      let capturedAuthHeader = null
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url, opts) => {
        capturedAuthHeader = opts?.headers?.Authorization || opts?.headers?.authorization
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }

      try {
        const channel = {
          type: 'openai-compatible',
          baseURL: 'https://fake.openai.com/v1',
          model: 'gpt-4o-mini',
        }

        // With keysFromEnv: [] no Authorization header should be set from env
        await runChannel(channel, {
          bytes: Buffer.from('test'),
          contentType: 'image/png',
          prompt: 'test',
          timeoutMs: 5000,
          keysFromEnv: [],
        })

        assert.equal(capturedAuthHeader, undefined)
      } finally {
        globalThis.fetch = originalFetch
      }
    } finally {
      if (origEnv !== undefined) process.env.OPENAI_API_KEY = origEnv
      else delete process.env.OPENAI_API_KEY
    }
  })
})
