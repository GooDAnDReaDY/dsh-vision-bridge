import { getPluginLogger } from './logger.js'
// dsh-vision-bridge — image preprocessing & deterministic visual algorithms
import zlib from 'node:zlib'
import { compressImage, deskewImage, enhanceImage, stripEXIF, imageDimensions, sniffMediaType, loadSharp } from './vision-core.js'

// --- CRC32 Table for PNG chunk creation ---
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  CRC_TABLE[n] = c
}

function makePngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.concat([t, data])
  const crc = Buffer.alloc(4)
  let c = 0xffffffff
  for (let i = 0; i < crcBuf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ crcBuf[i]) & 0xff]
  }
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([len, t, data, crc])
}

function paethPredictor(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Pure JavaScript PNG Decoder (zero external C++ dependencies).
 * Handles RGBA (6), RGB (2), Grayscale (0) PNG scanlines.
 */
export function decodePng(buf) {
  const b = Buffer.isBuffer(buf) ? buf : (buf instanceof Uint8Array ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : null)
  if (!b || b.length < 24) throw new Error('Invalid image buffer')
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) {
    throw new Error('Not a PNG image')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  const idatParts = []

  while (offset + 8 <= b.length) {
    const len = b.readUInt32BE(offset)
    if (offset + 12 + len > b.length) {
      throw new Error('Malformed PNG: chunk exceeds buffer length')
    }
    const type = b.toString('ascii', offset + 4, offset + 8)
    const data = b.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      if (data.length < 13) throw new Error('Malformed PNG: truncated IHDR')
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idatParts.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + len
  }

  if (width === 0 || height === 0 || idatParts.length === 0) {
    throw new Error('Malformed PNG structure')
  }

  // Decompression bomb / pixel count guard (#383)
  if (width * height > 50_000_000) {
    throw new Error(`PNG dimensions ${width}x${height} exceed safety limit`)
  }

  if (bitDepth !== 8) {
    throw new Error('Unsupported PNG bit depth: ' + bitDepth)
  }

  if (![0, 2, 4, 6].includes(colorType)) {
    throw new Error('Unsupported PNG color type: ' + colorType)
  }

  const decompressed = zlib.inflateSync(Buffer.concat(idatParts))
  const bpp = (colorType === 6) ? 4 : (colorType === 2) ? 3 : (colorType === 4) ? 2 : 1
  const stride = width * bpp
  const expectedDecompressedSize = height * (1 + stride)
  if (decompressed.length < expectedDecompressedSize) {
    throw new Error('Malformed PNG: truncated scanline data')
  }

  const rgba = Buffer.alloc(width * height * 4)
  let srcPos = 0
  const prevRow = Buffer.alloc(stride)
  const currRow = Buffer.alloc(stride)

  for (let y = 0; y < height; y++) {
    const filter = decompressed[srcPos++]
    for (let x = 0; x < stride; x++) {
      const raw = decompressed[srcPos++]
      const a = x >= bpp ? currRow[x - bpp] : 0
      const b = prevRow[x]
      const c = x >= bpp ? prevRow[x - bpp] : 0
      let val = raw
      if (filter === 1) val = (raw + a) & 0xff
      else if (filter === 2) val = (raw + b) & 0xff
      else if (filter === 3) val = (raw + Math.floor((a + b) / 2)) & 0xff
      else if (filter === 4) val = (raw + paethPredictor(a, b, c)) & 0xff
      currRow[x] = val
    }
    for (let x = 0; x < width; x++) {
      const dstIdx = (y * width + x) * 4
      if (bpp === 4) {
        rgba[dstIdx] = currRow[x * 4]
        rgba[dstIdx + 1] = currRow[x * 4 + 1]
        rgba[dstIdx + 2] = currRow[x * 4 + 2]
        rgba[dstIdx + 3] = currRow[x * 4 + 3]
      } else if (bpp === 3) {
        rgba[dstIdx] = currRow[x * 3]
        rgba[dstIdx + 1] = currRow[x * 3 + 1]
        rgba[dstIdx + 2] = currRow[x * 3 + 2]
        rgba[dstIdx + 3] = 255
      } else if (bpp === 2) {
        const g = currRow[x * 2]
        const a = currRow[x * 2 + 1]
        rgba[dstIdx] = g
        rgba[dstIdx + 1] = g
        rgba[dstIdx + 2] = g
        rgba[dstIdx + 3] = a
      } else {
        const g = currRow[x]
        rgba[dstIdx] = g
        rgba[dstIdx + 1] = g
        rgba[dstIdx + 2] = g
        rgba[dstIdx + 3] = 255
      }
    }
    currRow.copy(prevRow)
  }

  return { width, height, rgba }
}

/**
 * Pure JavaScript PNG Encoder.
 * Encodes an RGBA buffer into a standard PNG buffer.
 */
export function encodePng(arg1, arg2, arg3) {
  let width, height, rgba
  if (typeof arg1 === 'object' && arg1 !== null && !Buffer.isBuffer(arg1) && !(arg1 instanceof Uint8Array)) {
    width = arg1.width
    height = arg1.height
    const r = arg1.rgba
    rgba = Buffer.isBuffer(r) ? r : Buffer.from(r.buffer || r, r.byteOffset || 0, r.byteLength || (arg1.width * arg1.height * 4))
  } else {
    width = arg1
    height = arg2
    rgba = Buffer.isBuffer(arg3) ? arg3 : Buffer.from(arg3.buffer || arg3, arg3.byteOffset || 0, arg3.byteLength || (arg1 * arg2 * 4))
  }
  const stride = width * 4
  const rawWithFilter = Buffer.alloc(height * (stride + 1))
  let dstPos = 0
  for (let y = 0; y < height; y++) {
    rawWithFilter[dstPos++] = 0 // Filter type 0 (None)
    rgba.copy(rawWithFilter, dstPos, y * stride, (y + 1) * stride)
    dstPos += stride
  }

  const compressed = zlib.deflateSync(rawWithFilter)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 8-bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0 // Deflate
  ihdr[11] = 0 // Standard filter
  ihdr[12] = 0 // Non-interlaced

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Normalizes bbox coordinates to integer pixel bounds [x1, y1, x2, y2].
 */
export function normalizeBbox(bbox, width, height, options = {}) {
  let a, b, c, d
  if (Array.isArray(bbox) && bbox.length >= 4) {
    [a, b, c, d] = bbox.map(Number)
  } else if (typeof bbox === 'object' && bbox !== null) {
    if ('x' in bbox && 'width' in bbox) {
      a = Number(bbox.x)
      b = Number(bbox.y || 0)
      c = a + Number(bbox.width)
      d = b + Number(bbox.height || 0)
    } else if ('x1' in bbox && 'x2' in bbox) {
      a = Number(bbox.x1)
      b = Number(bbox.y1 || 0)
      c = Number(bbox.x2)
      d = Number(bbox.y2 || 0)
    } else {
      return [0, 0, width, height]
    }
  } else {
    return [0, 0, width, height]
  }
  if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) return [0, 0, width, height]

  const isObjectRect = typeof bbox === 'object' && !Array.isArray(bbox) && bbox !== null
  const isExplicitPixel = (options && (options.unit === 'pixel' || options.unit === 'pixels'))
    || (isObjectRect && (!bbox.unit || bbox.unit === 'pixel' || bbox.unit === 'pixels'))

  let x1, y1, x2, y2
  if (isExplicitPixel) {
    x1 = Math.round(a)
    y1 = Math.round(b)
    x2 = Math.round(c)
    y2 = Math.round(d)
  } else if (Math.max(a, b, c, d) <= 1.0 && Math.max(a, b, c, d) > 0) {
    // Normalized 0..1 scale
    x1 = Math.round(a * width)
    y1 = Math.round(b * height)
    x2 = Math.round(c * width)
    y2 = Math.round(d * height)
  } else {
    // Standard 0..1000 scale
    x1 = Math.round((a / 1000) * width)
    y1 = Math.round((b / 1000) * height)
    x2 = Math.round((c / 1000) * width)
    y2 = Math.round((d / 1000) * height)
  }

  const minX = Math.max(0, Math.min(width - 1, Math.min(x1, x2)))
  const maxX = Math.max(minX + 1, Math.min(width, Math.max(x1, x2)))
  const minY = Math.max(0, Math.min(height - 1, Math.min(y1, y2)))
  const maxY = Math.max(minY + 1, Math.min(height, Math.max(y1, y2)))

  return [minX, minY, maxX, maxY]
}

/**
 * Crop an image region, returning a new PNG Buffer.
 */
export async function cropImageRegion(bytes, bbox, options = {}) {
  const sharp = await loadSharp()

  const dims = imageDimensions(bytes)
  const origW = dims?.width || 800
  const origH = dims?.height || 600
  const [x1, y1, x2, y2] = normalizeBbox(bbox, origW, origH)
  const cropW = Math.max(1, x2 - x1)
  const cropH = Math.max(1, y2 - y1)

  if (sharp) {
    try {
      const cropped = await sharp(bytes).extract({ left: x1, top: y1, width: cropW, height: cropH }).png().toBuffer()
      return { bytes: cropped, width: cropW, height: cropH, contentType: 'image/png' }
    } catch (err) { getPluginLogger().debug('[dsh-vision-bridge] sharp crop failed:', err?.message || err) }
  }

  // Pure JS fallback via decodePng
  try {
    const { width, height, rgba } = decodePng(bytes)
    const [nx1, ny1, nx2, ny2] = normalizeBbox(bbox, width, height)
    const nw = Math.max(1, nx2 - nx1)
    const nh = Math.max(1, ny2 - ny1)
    const croppedRgba = Buffer.alloc(nw * nh * 4)

    for (let row = 0; row < nh; row++) {
      const srcOffset = ((ny1 + row) * width + nx1) * 4
      const dstOffset = row * nw * 4
      rgba.copy(croppedRgba, dstOffset, srcOffset, srcOffset + (nw * 4))
    }

    const pngBuffer = encodePng({ width: nw, height: nh, rgba: croppedRgba })
    return { bytes: pngBuffer, width: nw, height: nh, contentType: 'image/png' }
  } catch (err) {
    throw new Error('cropImageRegion failed: ' + err.message)
  }
}

/**
 * Annotate image with bounding boxes and text labels.
 */
export async function annotateImage(bytes, annotations = [], options = {}) {
  if (!Array.isArray(annotations) || annotations.length === 0) {
    return { bytes, contentType: 'image/png', count: 0 }
  }

  const { width, height, rgba } = decodePng(bytes)
  const thickness = options.thickness || 2

  const colorMap = {
    red: [239, 68, 68, 255],
    green: [34, 197, 94, 255],
    blue: [59, 130, 246, 255],
    yellow: [234, 179, 8, 255],
    purple: [168, 85, 247, 255],
    default: [239, 68, 68, 255],
  }

  let count = 0
  for (const item of annotations) {
    if (!item || !item.bbox) continue
    const [x1, y1, x2, y2] = normalizeBbox(item.bbox, width, height)
    const colorName = String(item.color || 'red').toLowerCase()
    const color = colorMap[colorName] || colorMap.default

    // Draw horizontal borders
    for (let t = 0; t < thickness; t++) {
      for (let x = x1; x <= x2; x++) {
        if (y1 + t < height) {
          const idx1 = ((y1 + t) * width + x) * 4
          rgba[idx1] = color[0]; rgba[idx1 + 1] = color[1]; rgba[idx1 + 2] = color[2]; rgba[idx1 + 3] = color[3]
        }
        if (y2 - t >= 0 && y2 - t < height) {
          const idx2 = ((y2 - t) * width + x) * 4
          rgba[idx2] = color[0]; rgba[idx2 + 1] = color[1]; rgba[idx2 + 2] = color[2]; rgba[idx2 + 3] = color[3]
        }
      }
    }

    // Draw vertical borders
    for (let t = 0; t < thickness; t++) {
      for (let y = y1; y <= y2; y++) {
        if (x1 + t < width) {
          const idx1 = (y * width + (x1 + t)) * 4
          rgba[idx1] = color[0]; rgba[idx1 + 1] = color[1]; rgba[idx1 + 2] = color[2]; rgba[idx1 + 3] = color[3]
        }
        if (x2 - t >= 0 && x2 - t < width) {
          const idx2 = (y * width + (x2 - t)) * 4
          rgba[idx2] = color[0]; rgba[idx2 + 1] = color[1]; rgba[idx2 + 2] = color[2]; rgba[idx2 + 3] = color[3]
        }
      }
    }
    count++
  }

  const encoded = encodePng({ width, height, rgba })
  return { bytes: encoded, contentType: 'image/png', count }
}

/**
 * Deterministically analyzes image quality metrics:
 *  - Mean brightness and RMS contrast
 *  - Laplacian variance blur score (sharp vs blurry detection)
 *  - 5-color dominant palette
 */
export async function analyzeImageQuality(bytes) {
  let decoded = null
  try {
    decoded = decodePng(bytes)
  } catch (_pngErr) {
    const sharp = await loadSharp()
    if (sharp) {
      try {
        const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        decoded = { width: info.width, height: info.height, rgba: data }
      } catch (_sharpErr) {
        // Sharp failed too
      }
    }
  }

  if (!decoded || !decoded.rgba || !decoded.width || !decoded.height) {
    throw new Error('analyzeImageQuality: unsupported format or invalid image data for quality analysis')
  }

  const { width, height, rgba } = decoded
  const total = width * height
  const gray = new Float32Array(total)
  let sumLuma = 0
  const colorBuckets = new Map()

  for (let i = 0; i < total; i++) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    const luma = 0.299 * r + 0.587 * g + 0.114 * b
    gray[i] = luma
    sumLuma += luma

    // 4-bit color quantization for dominant palette
    const qr = (r >> 4) << 4
    const qg = (g >> 4) << 4
    const qb = (b >> 4) << 4
    const hex = '#' + ((1 << 24) + (qr << 16) + (qg << 8) + qb).toString(16).slice(1)
    colorBuckets.set(hex, (colorBuckets.get(hex) || 0) + 1)
  }

  const meanLuma = sumLuma / total
  let sumSqDiff = 0
  for (let i = 0; i < total; i++) {
    const diff = gray[i] - meanLuma
    sumSqDiff += diff * diff
  }
  const contrast = Math.round(Math.sqrt(sumSqDiff / total))
  const brightness = Math.round((meanLuma / 255) * 100)

  // Laplacian variance operator on interior pixels
  let lapSum = 0
  let lapSumSq = 0
  let count = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      const lap = gray[idx + 1] + gray[idx - 1] + gray[idx + width] + gray[idx - width] - 4 * gray[idx]
      lapSum += lap
      lapSumSq += lap * lap
      count++
    }
  }

  const lapMean = count > 0 ? lapSum / count : 0
  const lapVar = count > 0 ? (lapSumSq / count) - (lapMean * lapMean) : 0
  const blurScore = Math.round(lapVar)
  const blurState = blurScore < 40 ? 'blurry' : blurScore < 120 ? 'moderate' : 'sharp'

  // Top 5 dominant colors
  const dominantPalette = Array.from(colorBuckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([hex]) => hex)

  const recommendation = blurState === 'blurry'
    ? 'Image appears blurry or out of focus. A clearer capture is recommended for fine details.'
    : 'Image clarity is adequate for visual inspection and recognition.'

  return {
    width,
    height,
    brightness,
    contrast,
    blurScore,
    blurState,
    dominantPalette,
    recommendation
  }
}

/**
 * Pixel-by-pixel deterministic comparison between two images.
 */
export async function computePixelDiff(bytesA, bytesB, options = {}) {
  const decA = decodePng(bytesA)
  const decB = decodePng(bytesB)

  if (decA.width !== decB.width || decA.height !== decB.height) {
    const totalA = decA.width * decA.height
    const totalB = decB.width * decB.height
    const maxTotal = Math.max(totalA, totalB)
    return {
      isIdentical: false,
      diffPercentage: 100,
      totalPixels: maxTotal,
      diffPixels: maxTotal,
      dimensionMismatch: true,
      changedBbox: [0, 0, Math.max(decA.width, decB.width), Math.max(decA.height, decB.height)]
    }
  }

  const { width, height } = decA
  const total = width * height
  const tolerance = typeof options.tolerance === 'number' ? Math.max(0, options.tolerance) : 30
  let diffCount = 0
  let minX = width, minY = height, maxX = 0, maxY = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const dr = Math.abs(decA.rgba[idx] - decB.rgba[idx])
      const dg = Math.abs(decA.rgba[idx + 1] - decB.rgba[idx + 1])
      const db = Math.abs(decA.rgba[idx + 2] - decB.rgba[idx + 2])
      const da = Math.abs(decA.rgba[idx + 3] - decB.rgba[idx + 3])
      if (dr + dg + db + da > tolerance) {
        diffCount++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  const diffPercentage = Number(((diffCount / total) * 100).toFixed(2))
  const isIdentical = diffCount === 0

  return {
    isIdentical,
    diffPercentage,
    diffPixels: diffCount,
    totalPixels: total,
    dimensionMismatch: false,
    changedBbox: isIdentical ? [] : [minX, minY, maxX, maxY]
  }
}

/**
 * Smartly optimizes image bytes before sending them to vision models
 */
export async function smartOptimizeImage(bytes, contentType, options = {}) {
  const isByteArr = Buffer.isBuffer(bytes) || (bytes instanceof Uint8Array)
  if (!isByteArr || bytes.length === 0) {
    return { bytes, contentType: contentType || 'image/png', optimized: false, warnings: [], preprocessed: true }
  }

  let currentBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let currentType = contentType || sniffMediaType(currentBytes) || 'image/png'
  let modified = false
  const warnings = []
  let preprocessed = true

  const {
    maxWidth = 1920,
    maxHeight = 1080,
    quality = 80,
    stripExifFlag = false,
    deskewFlag = false,
    enhanceFlag = false,
  } = options

  if (stripExifFlag) {
    try {
      const stripped = await stripEXIF(currentBytes, currentType, { throwOnError: true })
      if (stripped && stripped.length > 0 && stripped.length !== currentBytes.length) {
        currentBytes = stripped
        modified = true
      }
    } catch (err) {
      warnings.push(`stripEXIF failed: ${err?.message || err}`)
      preprocessed = false
    }
  }

  if (deskewFlag) {
    try {
      const deskewed = await deskewImage(currentBytes, currentType, { throwOnError: true })
      if (deskewed && deskewed.length > 0) {
        currentBytes = deskewed
        modified = true
      }
    } catch (err) {
      warnings.push(`deskew failed: ${err?.message || err}`)
      preprocessed = false
    }
  }

  if (enhanceFlag) {
    try {
      const enhanced = await enhanceImage(currentBytes, currentType, { throwOnError: true })
      if (enhanced && enhanced.length > 0) {
        currentBytes = enhanced
        modified = true
      }
    } catch (err) {
      warnings.push(`enhance failed: ${err?.message || err}`)
      preprocessed = false
    }
  }

  try {
    const dims = imageDimensions(currentBytes)
    if (dims && (dims.width > maxWidth || dims.height > maxHeight || currentBytes.length > 2 * 1024 * 1024)) {
      const compressed = await compressImage(currentBytes, currentType, {
        maxWidth,
        maxHeight,
        quality,
        format: options.format || 'auto',
      })
      if (compressed && compressed.bytes && compressed.bytes.length > 0 && compressed.bytes.length < currentBytes.length) {
        currentBytes = compressed.bytes
        currentType = compressed.contentType || currentType
        modified = true
      }
    }
  } catch (err) {
    warnings.push(`compression failed: ${err?.message || err}`)
  }

  return {
    bytes: currentBytes,
    contentType: currentType,
    optimized: modified,
    size: currentBytes.length,
    warnings,
    preprocessed,
  }
}
