import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodePng, computePixelDiff } from '../lib/image-processing.js'

describe('Issue #392: Pixel Diff Alpha, Tolerance=0, and Dimension Mismatch', () => {
  it('detects alpha channel differences between identical RGB pixels', async () => {
    // 1x1 transparent black vs 1x1 opaque black
    const pngA = encodePng(1, 1, Buffer.from([0, 0, 0, 0]))
    const pngB = encodePng(1, 1, Buffer.from([0, 0, 0, 255]))

    const diff = await computePixelDiff(pngA, pngB, { tolerance: 30 })
    assert.equal(diff.isIdentical, false, 'Images with different alpha must not be identical')
    assert.equal(diff.diffPixels, 1)
    assert.equal(diff.diffPercentage, 100)
    assert.deepEqual(diff.changedBbox, [0, 0, 0, 0])
  })

  it('honors tolerance=0 without overriding it with default 30', async () => {
    // 1x1 pixel with 1 unit RGB difference
    const pngA = encodePng(1, 1, Buffer.from([100, 100, 100, 255]))
    const pngB = encodePng(1, 1, Buffer.from([101, 100, 100, 255]))

    // With tolerance: 0 -> must detect the 1-unit difference
    const diffZero = await computePixelDiff(pngA, pngB, { tolerance: 0 })
    assert.equal(diffZero.isIdentical, false)
    assert.equal(diffZero.diffPixels, 1)

    // With tolerance: 30 -> 1 unit is within tolerance
    const diffDefault = await computePixelDiff(pngA, pngB, { tolerance: 30 })
    assert.equal(diffDefault.isIdentical, true)
    assert.equal(diffDefault.diffPixels, 0)
  })

  it('produces consistent counts on dimension mismatch (equal area, different aspect)', async () => {
    // 1x2 image vs 2x1 image (both have total area = 2 pixels)
    const png1x2 = encodePng(1, 2, Buffer.from([255, 0, 0, 255, 255, 0, 0, 255]))
    const png2x1 = encodePng(2, 1, Buffer.from([255, 0, 0, 255, 255, 0, 0, 255]))

    const diff = await computePixelDiff(png1x2, png2x1)
    assert.equal(diff.isIdentical, false)
    assert.equal(diff.dimensionMismatch, true)
    assert.equal(diff.diffPercentage, 100)
    assert.equal(diff.totalPixels, 2)
    assert.equal(diff.diffPixels, 2, 'diffPixels must match totalPixels on dimension mismatch, not 0')
  })

  it('conforms strictly to schema properties without undeclared dimensions', async () => {
    const png = encodePng(1, 1, Buffer.from([0, 0, 0, 255]))
    const diff = await computePixelDiff(png, png)

    const expectedKeys = new Set([
      'isIdentical',
      'diffPercentage',
      'diffPixels',
      'totalPixels',
      'dimensionMismatch',
      'changedBbox',
    ])
    for (const key of Object.keys(diff)) {
      assert.ok(expectedKeys.has(key), `Undeclared property "${key}" in pixel diff result`)
    }
  })
})
