// Tests for smart image processing & optimization pipeline
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { smartOptimizeImage } from '../lib/image-processing.js'

describe('smartOptimizeImage pipeline', async () => {
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

  it('handles empty or non-buffer inputs gracefully', async () => {
    const res1 = await smartOptimizeImage(null, 'image/png')
    assert.equal(res1.optimized, false)

    const res2 = await smartOptimizeImage(Buffer.alloc(0), 'image/png')
    assert.equal(res2.optimized, false)
  })

  it('returns valid buffer and content-type for normal image', async () => {
    const res = await smartOptimizeImage(tinyPng, 'image/png', { maxWidth: 1920, maxHeight: 1080 })
    assert.ok(Buffer.isBuffer(res.bytes))
    assert.equal(res.contentType, 'image/png')
    assert.ok(res.size > 0)
  })

  it('honors stripExifFlag without corrupting valid image', async () => {
    const res = await smartOptimizeImage(tinyPng, 'image/png', { stripExifFlag: true })
    assert.ok(Buffer.isBuffer(res.bytes))
  })

  it('reports preprocessed status and warnings when degradation occurs (#314)', async () => {
    // Calling with an invalid buffer that cannot be deskewed/enhanced/compressed
    const badBuffer = Buffer.from('not-an-image-data')
    const res = await smartOptimizeImage(badBuffer, 'image/png', {
      stripExifFlag: true,
      deskewFlag: true,
      enhanceFlag: true,
    })
    assert.equal(res.preprocessed, false)
    assert.ok(Array.isArray(res.warnings))
    assert.ok(res.warnings.length > 0)
    assert.deepEqual(res.bytes, badBuffer)
  })
})
