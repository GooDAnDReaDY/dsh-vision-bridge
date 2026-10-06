import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { decodePng, encodePng, smartOptimizeImage } from '../lib/image-processing.js'

function buildPngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  // Compute standard CRC32
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    crcTable[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < body.length; i++) {
    crc = crcTable[(crc ^ body[i]) & 0xff] ^ (crc >>> 8)
  }
  crc = (crc ^ 0xffffffff) >>> 0
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc, 0)
  return Buffer.concat([len, body, crcBuf])
}

function createType4Png(width, height, pixels) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 4 // color type 4: grayscale with alpha
  ihdrData[10] = 0 // deflate
  ihdrData[11] = 0 // filter
  ihdrData[12] = 0 // no interlace

  const ihdr = buildPngChunk('IHDR', ihdrData)

  // Build raw scanlines: filter 0 followed by 2 bytes per pixel
  const scanlines = []
  for (let y = 0; y < height; y++) {
    scanlines.push(0) // filter byte
    for (let x = 0; x < width; x++) {
      const p = pixels[y * width + x] || { gray: 0, alpha: 255 }
      scanlines.push(p.gray, p.alpha)
    }
  }

  const deflated = zlib.deflateSync(Buffer.from(scanlines))
  const idat = buildPngChunk('IDAT', deflated)
  const iend = buildPngChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([header, ihdr, idat, iend])
}

describe('Issue #383 & #384: PNG Decoder Hardening and Uint8Array Preprocessing', () => {
  it('smartOptimizeImage optimizes Uint8Array image bytes (#384)', async () => {
    // 2x2 test RGBA PNG
    const rawRgba = Buffer.from([
      255, 0, 0, 255,   0, 255, 0, 255,
      0, 0, 255, 255,   255, 255, 0, 255,
    ])
    const pngBuffer = encodePng({ width: 2, height: 2, rgba: rawRgba })
    const uint8Bytes = new Uint8Array(pngBuffer)

    // Pass Uint8Array with deskew and resize options
    const result = await smartOptimizeImage(uint8Bytes, 'image/png', {
      maxWidth: 10,
      maxHeight: 10,
      deskewFlag: false,
      stripExifFlag: false,
    })

    assert.equal(result.preprocessed, true)
    assert.ok(result.bytes)
    assert.ok(result.bytes.length > 0)
  })

  it('decodePng decodes colorType 4 (gray + alpha) into RGBA (#383)', () => {
    const pngBuf = createType4Png(2, 1, [
      { gray: 100, alpha: 200 },
      { gray: 50, alpha: 255 },
    ])

    const decoded = decodePng(pngBuf)
    assert.equal(decoded.width, 2)
    assert.equal(decoded.height, 1)

    // Pixel 0: gray=100, alpha=200 -> RGBA [100, 100, 100, 200]
    assert.equal(decoded.rgba[0], 100)
    assert.equal(decoded.rgba[1], 100)
    assert.equal(decoded.rgba[2], 100)
    assert.equal(decoded.rgba[3], 200)

    // Pixel 1: gray=50, alpha=255 -> RGBA [50, 50, 50, 255]
    assert.equal(decoded.rgba[4], 50)
    assert.equal(decoded.rgba[5], 50)
    assert.equal(decoded.rgba[6], 50)
    assert.equal(decoded.rgba[7], 255)
  })

  it('decodePng rejects truncated scanline data (#383)', () => {
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ihdrData = Buffer.alloc(13)
    ihdrData.writeUInt32BE(100, 0)
    ihdrData.writeUInt32BE(100, 4)
    ihdrData[8] = 8
    ihdrData[9] = 6 // RGBA
    const ihdr = buildPngChunk('IHDR', ihdrData)
    // Incomplete IDAT with only 10 bytes deflated
    const idat = buildPngChunk('IDAT', zlib.deflateSync(Buffer.alloc(10)))
    const iend = buildPngChunk('IEND', Buffer.alloc(0))
    const truncatedPng = Buffer.concat([header, ihdr, idat, iend])

    assert.throws(() => {
      decodePng(truncatedPng)
    }, /truncated scanline data/)
  })

  it('decodePng rejects decompression bomb dimensions (#383)', () => {
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ihdrData = Buffer.alloc(13)
    ihdrData.writeUInt32BE(10000, 0)
    ihdrData.writeUInt32BE(10000, 4) // 100 MP > 50 MP limit
    ihdrData[8] = 8
    ihdrData[9] = 6
    const ihdr = buildPngChunk('IHDR', ihdrData)
    const idat = buildPngChunk('IDAT', zlib.deflateSync(Buffer.alloc(10)))
    const iend = buildPngChunk('IEND', Buffer.alloc(0))
    const bombPng = Buffer.concat([header, ihdr, idat, iend])

    assert.throws(() => {
      decodePng(bombPng)
    }, /dimensions 10000x10000 exceed safety limit/)
  })
})
