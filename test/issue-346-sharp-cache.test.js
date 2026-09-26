// #346: sharp availability caching across vision-core operations
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  loadSharp,
  _resetSharpCacheForTests,
  compressImage,
  stripEXIF,
  checkImageQuality,
  pHash,
} from '../lib/vision-core.js'

describe('#346 loadSharp caching', () => {
  it('caches the resolved value across consecutive invocations', async () => {
    _resetSharpCacheForTests(undefined)
    const first = await loadSharp()
    const second = await loadSharp()
    assert.equal(first, second, 'consecutive calls must return identical cached result')
  })

  it('allows graceful degradation across image operations without repeated imports', async () => {
    const dummyBytes = Buffer.from('not an image')
    // None of these should throw uncaught module errors
    const compressed = await compressImage(dummyBytes, 'image/jpeg')
    assert.ok(compressed.bytes)

    const stripped = await stripEXIF(dummyBytes, 'image/jpeg')
    assert.ok(stripped)

    const quality = await checkImageQuality(dummyBytes)
    assert.ok(quality.score !== undefined)

    const hash = await pHash(dummyBytes)
    assert.ok(typeof hash === 'string')
  })

  it('uses mock sharp when cached in loadSharp', async () => {
    let mockCalled = false
    const mockSharp = () => {
      mockCalled = true
      return {
        metadata: async () => ({ width: 100, height: 100 }),
        jpeg: () => ({ toBuffer: async () => Buffer.from('small') }),
      }
    }
    _resetSharpCacheForTests(mockSharp)

    try {
      const largeInput = Buffer.alloc(1000)
      const res = await compressImage(largeInput, 'image/jpeg', { format: 'jpeg' })
      assert.equal(mockCalled, true, 'mock sharp was invoked via loadSharp')
      assert.equal(res.bytes.toString(), 'small')
    } finally {
      _resetSharpCacheForTests(undefined)
    }
  })
})
