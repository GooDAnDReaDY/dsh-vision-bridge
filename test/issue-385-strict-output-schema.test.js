import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerAnalysisTools } from '../lib/tools/analysis.js'
import { checkImageQuality } from '../lib/vision-core.js'

function validateAgainstSchema(value, schema, path = '') {
  assert.ok(schema, `Schema must be defined for ${path || 'root'}`)
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object', `${path}: expected object`)
    assert.ok(value !== null, `${path}: expected non-null object`)
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        assert.ok(schema.properties && schema.properties[k], `${path}: undeclared property "${k}" in object`)
      }
    }
    if (schema.properties) {
      for (const [k, propSchema] of Object.entries(schema.properties)) {
        if (value[k] !== undefined) {
          validateAgainstSchema(value[k], propSchema, `${path}.${k}`)
        }
      }
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path}: expected array`)
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validateAgainstSchema(value[i], schema.items, `${path}[${i}]`)
      }
    }
  } else if (schema.type === 'string') {
    assert.equal(typeof value, 'string', `${path}: expected string, got ${typeof value}`)
  } else if (schema.type === 'number') {
    assert.equal(typeof value, 'number', `${path}: expected number, got ${typeof value}`)
    assert.ok(!Number.isNaN(value), `${path}: expected finite number, got NaN`)
  } else if (schema.type === 'boolean') {
    assert.equal(typeof value, 'boolean', `${path}: expected boolean, got ${typeof value}`)
  }
}

describe('Issue #385: Strict output schema compliance across analysis tools', () => {
  it('vision_diff output satisfies schema on successful structured response and on parse warning', async () => {
    const tools = []
    let callIndex = 0
    let modelPrompt = ''
    const ctx = {
      tools: { register: (t) => tools.push(t) },
    }
    const config = { timeoutMs: 30000 }
    const attachmentById = new Map([
      ['att-1', { ref: 'ref-1' }],
      ['att-2', { ref: 'ref-2' }],
    ])
    const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex')
    const resolveImageBytes = async () => ({ bytes: tinyPng, contentType: 'image/png' })

    // Case 1: Model returns valid comparison JSON
    const callVisionModelWithBytesSuccess = async (_bytes, _type, prompt) => {
      callIndex++
      if (callIndex <= 2) return { description: 'Description ' + callIndex }
      return {
        description: '```json\n{"differences":[{"area":"navbar","before":"blue","after":"dark blue"}],"summary":"Navbar color updated"}\n```',
      }
    }

    registerAnalysisTools({
      ctx,
      config,
      attachmentById,
      resolveImageBytes,
      callVisionModelWithBytes: callVisionModelWithBytesSuccess,
      liveChannels: async () => [],
    })

    const tool = tools.find((t) => t.name === 'vision_diff')
    assert.ok(tool, 'vision_diff must be registered')

    const resSuccess = await tool.execute({ attachmentIdA: 'att-1', attachmentIdB: 'att-2' })
    validateAgainstSchema(resSuccess, tool.output.schema, 'vision_diff.success')

    // Case 2: Model returns unstructured non-JSON (parse warning fallback)
    callIndex = 0
    const callVisionModelWithBytesFallback = async (_bytes, _type, _prompt) => {
      callIndex++
      if (callIndex <= 2) return { description: 'Description ' + callIndex }
      return { description: 'The second image looks slightly darker than the first.' }
    }
    const toolsFallback = []
    registerAnalysisTools({
      ctx: { tools: { register: (t) => toolsFallback.push(t) } },
      config,
      attachmentById,
      resolveImageBytes,
      callVisionModelWithBytes: callVisionModelWithBytesFallback,
      liveChannels: async () => [],
    })
    const toolFallback = toolsFallback.find((t) => t.name === 'vision_diff')
    const resFallback = await toolFallback.execute({ attachmentIdA: 'att-1', attachmentIdB: 'att-2' })
    validateAgainstSchema(resFallback, toolFallback.output.schema, 'vision_diff.fallback')
    assert.ok(resFallback.parseWarning, 'parseWarning must be present on non-JSON response')
    assert.ok(resFallback.raw, 'raw must be present on non-JSON response')
    assert.ok(Array.isArray(resFallback.warnings) && resFallback.warnings.length > 0, 'warnings array must contain parse warning')
  })

  it('vision_consensus output satisfies schema in multi-model and fallback paths', async () => {
    const tools = []
    const ctx = { tools: { register: (t) => tools.push(t) } }
    const config = { timeoutMs: 30000, consensusEnabled: true }
    const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex')
    const resolveSourceBytes = async () => ({ bytes: tinyPng, contentType: 'image/png' })

    // Fallback path (<2 channels)
    const callVisionModelWithBytesFallback = async () => ({ description: 'Single model output description' })
    registerAnalysisTools({
      ctx,
      config,
      attachmentById: new Map(),
      resolveSourceBytes,
      callVisionModelWithBytes: callVisionModelWithBytesFallback,
      liveChannels: async () => [],
      effectivePrompt: (p) => p,
    })

    const tool = tools.find((t) => t.name === 'vision_consensus')
    assert.ok(tool, 'vision_consensus must be registered')
    const resFallback = await tool.execute({ attachmentId: 'att-1', question: 'test' })
    validateAgainstSchema(resFallback, tool.output.schema, 'vision_consensus.fallback')
  })

  it('checkImageQuality returns string blur and non-negative score across all error and success states', async () => {
    const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex')
    const normalRes = await checkImageQuality(tinyPng)
    assert.equal(typeof normalRes.blur, 'string', 'blur must be a string')
    assert.equal(typeof normalRes.score, 'number')
    assert.equal(typeof normalRes.lighting, 'number')
    assert.equal(typeof normalRes.note, 'string')

    // On invalid/corrupt buffer:
    const corruptRes = await checkImageQuality(Buffer.from('not an image'))
    assert.equal(typeof corruptRes.blur, 'string', 'corrupt buffer must return string blur, not number 0')
    assert.equal(corruptRes.blur, 'unknown')
    assert.equal(corruptRes.score, 0, 'corrupt buffer score must be 0, not 100')
    assert.equal(typeof corruptRes.note, 'string')
  })
})
