import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerAnalysisTools } from '../lib/tools/analysis.js'
import { registerMediaTools } from '../lib/tools/media.js'

describe('Issue #394: Truthful indeterminate evaluation on invalid JSON and unverified fallback', () => {
  const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex')
  const resolveSourceBytes = async () => ({ bytes: tinyPng, contentType: 'image/png' })

  it('vision_audit_accessibility returns score 0 and passed false on non-JSON model response', async () => {
    const tools = []
    const ctx = { tools: { register: (t) => tools.push(t) } }
    const config = { timeoutMs: 30000 }
    const callVisionModelWithBytes = async () => ({
      description: 'Sorry, I cannot provide JSON for this image right now. Looks okay though.',
    })

    registerAnalysisTools({
      ctx,
      config,
      attachmentById: new Map(),
      resolveSourceBytes,
      callVisionModelWithBytes,
      liveChannels: async () => [],
      effectivePrompt: (p) => p,
    })

    const tool = tools.find((t) => t.name === 'vision_audit_accessibility')
    assert.ok(tool, 'vision_audit_accessibility must be registered')

    const res = await tool.execute({ attachmentId: 'att-1' })
    assert.equal(res.score, 0, 'Invalid JSON must result in score 0, not default 85')
    assert.equal(res.passed, false, 'Invalid JSON must not pass evaluation')
    assert.ok(Array.isArray(res.warnings) && res.warnings.length > 0, 'Must record warning about unparseable JSON')
  })

  it('vision_audit_accessibility strictly honors string "false" in passed field', async () => {
    const tools = []
    const ctx = { tools: { register: (t) => tools.push(t) } }
    const config = { timeoutMs: 30000 }
    const callVisionModelWithBytes = async () => ({
      description: '{"score": 80, "passed": "false", "issues": []}',
    })

    registerAnalysisTools({
      ctx,
      config,
      attachmentById: new Map(),
      resolveSourceBytes,
      callVisionModelWithBytes,
      liveChannels: async () => [],
      effectivePrompt: (p) => p,
    })

    const tool = tools.find((t) => t.name === 'vision_audit_accessibility')
    const res = await tool.execute({ attachmentId: 'att-1' })
    assert.equal(res.score, 80)
    assert.equal(res.passed, false, 'String "false" must not be coerced to boolean true')
  })

  it('vision_verify_generated_image returns score 0 and passed false on invalid JSON', async () => {
    const tools = []
    const ctx = { tools: { register: (t) => tools.push(t) } }
    const config = { timeoutMs: 30000 }
    const callVisionModelWithBytes = async () => ({
      description: 'This is an image of a cat. It has 4 legs and whiskers.',
    })

    registerMediaTools({
      ctx,
      config,
      attachmentById: new Map(),
      resolveSourceBytes,
      callVisionModelWithBytes,
    })

    const tool = tools.find((t) => t.name === 'vision_verify_generated_image')
    assert.ok(tool, 'vision_verify_generated_image must be registered')

    const res = await tool.execute({ attachmentId: 'att-1', prompt: 'a cat' })
    assert.equal(res.score, 0, 'Invalid JSON must result in score 0, not default 90')
    assert.equal(res.passed, false, 'Invalid JSON must not pass verification')
    assert.ok(Array.isArray(res.warnings) && res.warnings.length > 0, 'Must record warning')
  })

  it('vision_consensus returns confidence 0 and discrepancy warning on single-model fallback', async () => {
    const tools = []
    const ctx = { tools: { register: (t) => tools.push(t) } }
    const config = { timeoutMs: 30000, consensusEnabled: true }
    const callVisionModelWithBytes = async () => ({
      description: 'Single model output description',
    })

    registerAnalysisTools({
      ctx,
      config,
      attachmentById: new Map(),
      resolveSourceBytes,
      callVisionModelWithBytes,
      liveChannels: async () => [],
      effectivePrompt: (p) => p,
    })

    const tool = tools.find((t) => t.name === 'vision_consensus')
    const res = await tool.execute({ attachmentId: 'att-1', question: 'check' })
    assert.equal(res.confidence, 0, 'Single model fallback must have confidence 0, not fake 95')
    assert.ok(res.discrepancies.some((d) => d.includes('Single-model fallback')), 'Discrepancies must declare fallback')
    assert.ok(res.warnings.some((w) => w.includes('Minimum agreement')), 'Warnings must explain fallback')
  })
})
