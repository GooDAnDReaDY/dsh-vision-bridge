import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment } from './harness.js'

describe('issue #343: vision_consensus parallel channel queries', () => {
  it('registers vision_consensus and executes with channels config', async () => {
    const { ctx } = await setupWithAttachment({
      config: {
        consensusEnabled: true,
        channels: [
          { type: 'ollama', baseURL: 'http://localhost:11434/v1', model: 'llava', apiKey: 'test' },
          { type: 'ollama', baseURL: 'http://localhost:11434/v1', model: 'bakllava', apiKey: 'test' },
        ],
      },
    })
    const tool = ctx.toolDefs.get('vision_consensus')
    assert.ok(tool, 'vision_consensus must be registered when consensusEnabled=true')

    const res = await tool.execute({ attachmentId: 'att-1', question: 'compare models' }, undefined)
    assert.ok(res, 'result must exist')
    assert.ok(typeof res.consensus === 'string', 'consensus must be a string')
    assert.ok(Array.isArray(res.modelsQueried), 'modelsQueried must be an array')
  })
})
