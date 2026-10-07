// #314: Verification tests for real bestEffort logging and tool warnings
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bestEffort } from '../lib/vision-core.js'
import { smartOptimizeImage } from '../lib/image-processing.js'
import { setupWithAttachment } from './harness.js'

describe('#314 bestEffort helper and degradation warnings', () => {
  it('bestEffort returns result of successful function', () => {
    const res = bestEffort('test.success', () => 42)
    assert.equal(res, 42)
  })

  it('bestEffort catches sync errors, logs to console.debug, and returns fallback', () => {
    const logs = []
    const origDebug = console.debug
    console.debug = (...args) => logs.push(args.join(' '))
    try {
      const res = bestEffort('test.syncError', () => {
        throw new Error('boom')
      }, 'fallback-value')
      assert.equal(res, 'fallback-value')
      assert.ok(logs.some((l) => l.includes('[dsh-vision-bridge] bestEffort (test.syncError) caught: boom')))
    } finally {
      console.debug = origDebug
    }
  })

  it('bestEffort handles asynchronous promise rejections', async () => {
    const logs = []
    const origDebug = console.debug
    console.debug = (...args) => logs.push(args.join(' '))
    try {
      const res = await bestEffort('test.asyncError', async () => {
        throw new Error('async-fail')
      }, 'async-fallback')
      assert.equal(res, 'async-fallback')
      assert.ok(logs.some((l) => l.includes('[dsh-vision-bridge] bestEffort (test.asyncError) caught: async-fail')))
    } finally {
      console.debug = origDebug
    }
  })

  it('smartOptimizeImage returns warnings and preprocessed status on failure', async () => {
    const res = await smartOptimizeImage(Buffer.from('not-an-image'), 'image/png', { deskewFlag: true })
    assert.ok(Array.isArray(res.warnings), 'warnings must be an array')
    assert.equal(res.preprocessed, false, 'preprocessed must be false when step fails')
    assert.ok(res.warnings.length > 0, 'warnings must capture the failure')
  })

  it('vision_extract_formula surfaces warnings on non-JSON model response', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('vision_extract_formula')
    assert.ok(tool, 'vision_extract_formula must be registered')
    const res = await tool.execute({ attachmentId: 'att-1' }, undefined)
    assert.ok(Array.isArray(res.warnings), 'must return warnings array')
    assert.ok(res.warnings.length > 0, 'must have parse warning because mock output is plain text')
    assert.match(res.warnings[0], /Failed to parse structured JSON/)
  })

  it('vision_extract_table surfaces warnings on non-JSON model response', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('vision_extract_table')
    assert.ok(tool, 'vision_extract_table must be registered')
    const res = await tool.execute({ attachmentId: 'att-1' }, undefined)
    assert.ok(Array.isArray(res.warnings), 'must return warnings array')
    assert.ok(res.warnings.length > 0, 'must have parse warning')
    assert.match(res.warnings[0], /Failed to parse table JSON/)
  })

  it('vision_scan_barcode surfaces warnings on non-JSON model response', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('vision_scan_barcode')
    assert.ok(tool, 'vision_scan_barcode must be registered')
    const res = await tool.execute({ attachmentId: 'att-1' }, undefined)
    assert.ok(Array.isArray(res.warnings), 'must return warnings array')
    assert.ok(res.warnings.length > 0, 'must have parse warning')
    assert.match(res.warnings[0], /Failed to parse barcode JSON/)
  })

  it('vision_extract_structured surfaces warnings on non-JSON model response', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('vision_extract_structured')
    assert.ok(tool, 'vision_extract_structured must be registered')
    const res = await tool.execute({ attachmentId: 'att-1' }, undefined)
    assert.ok(Array.isArray(res.warnings), 'must return warnings array')
    assert.ok(res.warnings.length > 0, 'must have parse warning')
    assert.match(res.warnings[0], /Failed to parse structured JSON/)
  })

  it('vision_describe_structured surfaces warnings on non-JSON model response', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('vision_describe_structured')
    assert.ok(tool, 'vision_describe_structured must be registered')
    const res = await tool.execute({ attachmentId: 'att-1' }, undefined)
    assert.ok(Array.isArray(res.warnings), 'must return warnings array')
    assert.ok(res.warnings.length > 0, 'must have parse warning')
    assert.match(res.warnings[0], /Failed to parse structured JSON/)
  })

  it('vision_ocr output schema declares warnings and returns array', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('vision_ocr')
    assert.ok(tool, 'vision_ocr must be registered')
    assert.ok(tool.output.schema.properties.warnings, 'schema must include warnings property')
    const res = await tool.execute({ attachmentId: 'att-1' }, undefined)
    assert.ok(Array.isArray(res.warnings), 'warnings must be an array')
  })
})
