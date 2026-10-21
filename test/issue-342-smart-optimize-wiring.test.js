import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { smartOptimizeImage } from '../lib/index.js'
import { smartOptimizeImage as smartFromImageProc } from '../lib/image-processing.js'

describe('issue #342: smartOptimizeImage wired into runtime pipeline and exported', () => {
  it('re-exports smartOptimizeImage from lib/index.js matching lib/image-processing.js', () => {
    assert.equal(typeof smartOptimizeImage, 'function')
    assert.strictEqual(smartOptimizeImage, smartFromImageProc)
  })

  it('smartOptimizeImage honors dimensions and produces valid buffer on valid image', async () => {
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
    const res = await smartOptimizeImage(tinyPng, 'image/png', {
      maxWidth: 800,
      maxHeight: 600,
      quality: 85,
    })
    assert.ok(Buffer.isBuffer(res.bytes))
    assert.ok(res.bytes.length > 0)
    assert.equal(res.preprocessed, true)
    assert.deepEqual(res.warnings, [])
  })

  it('smartOptimizeImage propagates warnings when deskew/enhance/stripEXIF fails or is unavailable', async () => {
    const badBytes = Buffer.from('corrupt-non-image-bytes')
    const res = await smartOptimizeImage(badBytes, 'image/png', {
      stripExifFlag: true,
      deskewFlag: true,
      enhanceFlag: true,
    })
    assert.equal(res.preprocessed, false)
    assert.ok(Array.isArray(res.warnings))
    assert.ok(res.warnings.length > 0)
    assert.ok(res.warnings.some((w) => w.includes('deskew') || w.includes('enhance') || w.includes('stripEXIF')))
  })
})
