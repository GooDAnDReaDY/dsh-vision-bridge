import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { smartOptimizeImage, analyzeImageQuality, encodePng } from '../lib/image-processing.js'

describe('Issue #393 & #395: Optimizer Auto Format & Deterministic Image Quality', () => {
  it('Issue #393: smartOptimizeImage without format option does not crash on undeclared auto', async () => {
    // 20x20 red PNG, requested max dimensions 10x10 to trigger compression
    const rawRgba = Buffer.alloc(20 * 20 * 4)
    for (let i = 0; i < rawRgba.length; i += 4) {
      rawRgba[i] = 255     // R
      rawRgba[i + 3] = 255 // A
    }
    const png = encodePng(20, 20, rawRgba)

    const opt = await smartOptimizeImage(png, 'image/png', {
      maxWidth: 10,
      maxHeight: 10,
      // No format specified — must default to 'auto' without ReferenceError
    })

    assert.ok(opt.bytes)
    assert.equal(opt.preprocessed, true)
    const hasAutoError = (opt.warnings || []).some(w => w.includes('auto is not defined'))
    assert.equal(hasAutoError, false, 'Must not encounter ReferenceError: auto is not defined')
  })

  it('Issue #395: analyzeImageQuality rejects invalid non-image bytes instead of fabricating fake metrics', async () => {
    const corruptBytes = Buffer.from('this is not a valid image payload at all')

    await assert.rejects(
      async () => {
        await analyzeImageQuality(corruptBytes)
      },
      /unsupported format or invalid image data/,
      'Must reject corrupt bytes rather than returning fake 50/50/100 metrics',
    )
  })

  it('Issue #395: analyzeImageQuality produces real measurements on valid images', async () => {
    // 10x10 all white image -> brightness 100%, contrast 0
    const rawWhite = Buffer.alloc(10 * 10 * 4)
    for (let i = 0; i < rawWhite.length; i += 4) {
      rawWhite[i] = 255
      rawWhite[i + 1] = 255
      rawWhite[i + 2] = 255
      rawWhite[i + 3] = 255
    }
    const whitePng = encodePng(10, 10, rawWhite)

    const quality = await analyzeImageQuality(whitePng)
    assert.equal(quality.width, 10)
    assert.equal(quality.height, 10)
    assert.equal(quality.brightness, 100)
    assert.equal(quality.contrast, 0)
    assert.ok(Array.isArray(quality.dominantPalette))
    assert.ok(quality.dominantPalette.length > 0)
    assert.equal(typeof quality.blurScore, 'number')
    assert.equal(typeof quality.blurState, 'string')
    assert.equal(quality.note, undefined, 'Must not return undeclared note property')
  })
})
