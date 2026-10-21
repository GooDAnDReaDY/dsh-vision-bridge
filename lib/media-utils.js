import { getPluginLogger } from './logger.js'
import { runProcessAsync, isBinaryAvailable } from './process.js'

/**
 * Executes an action safely, capturing any error and logging at debug level if available.
 * Returns the fallback value if the action throws or rejects.
 */
export function bestEffort(label, fn, fallback = undefined) {
  let op = fn
  let tag = label
  let defVal = fallback
  if (typeof tag === 'function') {
    op = label
    tag = typeof fn === 'string' ? fn : ''
    defVal = fallback
  }
  try {
    const res = typeof op === 'function' ? op() : op
    if (res && typeof res.catch === 'function') {
      return res.catch((err) => {
        if (tag) { getPluginLogger().debug(`[dsh-vision-bridge] bestEffort (${tag}) caught:`, err?.message || err) }
        return defVal
      })
    }
    return res
  } catch (err) {
    if (tag) { getPluginLogger().debug(`[dsh-vision-bridge] bestEffort (${tag}) caught:`, err?.message || err) }
    return defVal
  }
}

export async function runLocalOCR(bytes, contentType = 'image/png', lang = 'eng') {
  try {
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { writeFileSync, unlinkSync } = await import('node:fs')
    const hasTess = await isBinaryAvailable('tesseract')
    if (hasTess) {
      const stem = 'vbtess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
      const imgPath = join(tmpdir(), stem + '.png')
      writeFileSync(imgPath, bytes)
      try {
        const r = await runProcessAsync('tesseract', [imgPath, 'stdout', '-l', lang || 'eng', '--psm', '3'], { timeout: 15000 })
        const text = (r.stdout || '').trim()
        if (text) return text
      } finally {
        bestEffort('tesseract.unlink', () => unlinkSync(imgPath))
      }
    }
  } catch (err) { getPluginLogger().debug('[dsh-vision-bridge] runLocalOCR failed:', err?.message || err) }
  return ''
}

/**
 * Recursively rewrite image blocks anywhere in a content tree (including
 * inside tool-result blocks and top-level tool results), and collect every
 * attachment reference found so describe_image can read them by id.
 */
export async function rewriteImagesDeep(content, replace) {
  const attachments = []
  const walk = async (blocks) => {
    if (!Array.isArray(blocks)) return { content: blocks, changed: false }
    let changed = false
    const next = []
    for (const block of blocks) {
      if (block && block.type === 'image') {
        if (block.attachment) attachments.push(block.attachment)
        changed = true
        // replace may be sync or async; await the (possibly already-resolved) value.
        const out = await (async () => Promise.resolve(replace(block)))()
        if (out !== undefined && out !== null) {
          if (Array.isArray(out)) next.push(...out)
          else next.push(out)
        }
        continue
      }
      if (block && Array.isArray(block.content)) {
        const nested = await walk(block.content)
        if (nested.changed) {
          changed = true
          next.push({ ...block, content: nested.content })
          continue
        }
      }
      next.push(block)
    }
    return { content: changed ? next : blocks, changed }
  }
  const result = await walk(content)
  return { content: result.content, changed: result.changed, attachments }
}

/** Marks a request this plugin re-dispatched, so the interceptor does not recurse. */
export const VISION_PASS = Symbol.for('dsh-vision-bridge/pass')

/** Very small content-type sniffer for the common raster formats. */
export function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 3) return undefined
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  // RIFF....WEBP
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  // ISO-BMFF: ....ftypavif / ....ftypavis
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
    && bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && (bytes[11] === 0x66 || bytes[11] === 0x73)) return 'image/avif'
  return undefined
}

/**
 * Resize and compress an image for token savings.
 * Returns {bytes, contentType} — original if no compression needed or sharp unavailable.
 */
let sharpCached = undefined
/**
 * Cached loader for sharp to avoid repeated dynamic import failures when not installed (#346).
 */
export async function loadSharp() {
  if (sharpCached !== undefined) return sharpCached
  try {
    const mod = await import('sharp')
    sharpCached = mod.default || mod
  } catch (err) {
    /* optional dependency probe */
    void err
    sharpCached = null
  }
  return sharpCached
}

export function _resetSharpCacheForTests(val = undefined) {
  sharpCached = val
}

export async function compressImage(bytes, contentType, opts) {
  const sharp = await loadSharp()
  if (!sharp) return { bytes, contentType }

  const { maxWidth = 1920, maxHeight = 1080, quality = 80, format = 'auto' } = opts || {}

  try {
    const img = sharp(bytes)
    const meta = await img.metadata()
    const needsResize = (meta.width && meta.width > maxWidth) || (meta.height && meta.height > maxHeight)

    let pipeline = img
    if (needsResize) {
      pipeline = pipeline.resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
    }

    let outFormat = format
    if (outFormat === 'auto') outFormat = 'webp'

    let outBytes, outType
    if (outFormat === 'webp') {
      outBytes = await pipeline.webp({ quality }).toBuffer()
      outType = 'image/webp'
    } else if (outFormat === 'avif') {
      outBytes = await pipeline.avif({ quality }).toBuffer()
      outType = 'image/avif'
    } else if (outFormat === 'png') {
      outBytes = await pipeline.png({ compressionLevel: 9 }).toBuffer()
      outType = 'image/png'
    } else {
      outBytes = await pipeline.jpeg({ quality }).toBuffer()
      outType = 'image/jpeg'
    }

    if (outBytes.length < bytes.length) {
      return { bytes: outBytes, contentType: outType }
    }
    return { bytes, contentType }
  } catch {
    return { bytes, contentType }
  }
}

/**
 * Strip EXIF metadata from image bytes.
 * ponytail: uses sharp if available, otherwise returns original. Upgrade to exif-reader for standalone.
 */
export async function stripEXIF(bytes, contentType, opts = {}) {
  const sharp = await loadSharp()
  if (!sharp) {
    if (opts && opts.throwOnError) {
      const err = new Error('sharp unavailable')
      err.code = 'ERR_SHARP_UNAVAILABLE'
      throw err
    }
    return bytes
  }
  try {
    // sharp strips EXIF by default when outputting
    const pipeline = sharp(bytes)
    const meta = await pipeline.metadata()
    if (contentType === 'image/png') {
      return await pipeline.png().toBuffer()
    }
    return await pipeline.jpeg().toBuffer()
  } catch (err) {
    if (opts && opts.throwOnError) throw err
    return bytes
  }
}

/**
 * Deskew an image — detect rotation angle and correct it.
 * ponytail: uses sharp with auto-rotate based on EXIF.
 */
export async function deskewImage(bytes, contentType, opts = {}) {
  const sharp = await loadSharp()
  if (!sharp) {
    if (opts && opts.throwOnError) {
      const err = new Error('sharp unavailable')
      err.code = 'ERR_SHARP_UNAVAILABLE'
      throw err
    }
    return bytes
  }
  try {
    let pipeline = sharp(bytes).rotate()
    if (contentType === 'image/png') {
      return await pipeline.png().toBuffer()
    }
    return await pipeline.jpeg().toBuffer()
  } catch (err) {
    if (opts && opts.throwOnError) throw err
    return bytes
  }
}

/**
 * Enhance image — apply contrast normalization and sharpening.
 */
export async function enhanceImage(bytes, contentType, opts = {}) {
  const sharp = await loadSharp()
  if (!sharp) {
    if (opts && opts.throwOnError) {
      const err = new Error('sharp unavailable')
      err.code = 'ERR_SHARP_UNAVAILABLE'
      throw err
    }
    return bytes
  }
  try {
    let pipeline = sharp(bytes).normalize().sharpen({ sigma: 0.5 })
    if (contentType === 'image/png') {
      return await pipeline.png().toBuffer()
    }
    return await pipeline.jpeg().toBuffer()
  } catch (err) {
    if (opts && opts.throwOnError) throw err
    return bytes
  }
}


// #91: parse width*height out of a PNG/JPEG header without a native image lib.
// Returns null when the format is unknown to us (guard is then skipped).
// #115: bytes may be a Buffer (URL/path fetch) or a Uint8Array (attachment
// readImage). readUInt32BE is Buffer-only, so normalize once at the top.
export function imageDimensions(bytes) {
  if (!bytes || bytes.length < 24) return null
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength)
  // PNG: IHDR at offset 16 -> width (16..20), height (20..24), big-endian.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // JPEG: walk SOF markers (C0..CF, minus C4/C8/CC) for frame dims.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = (buf[i + 2] << 8) | buf[i + 3]
      if (len < 2 || i + 2 + len > buf.length) return null
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (buf[i + 5] << 8) | buf[i + 6], width: (buf[i + 7] << 8) | buf[i + 8] }
      }
      i += 2 + len
    }
    return null
  }
  return null
}

/**
 * Scale a bbox from 0-1000 normalized coords to image pixels (#166).
 * x-coords scale by width, y-coords by height; clamped and rounded so the
 * rect stays inside the image. Returns [] for malformed input.
 */
export function scaleBbox(bbox, width, height) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return []
  const w = Number(width) > 0 ? Number(width) : 1000
  const h = Number(height) > 0 ? Number(height) : 1000
  const clampPx = (v, max) => Math.max(0, Math.min(max, Math.round(v)))
  const x1 = clampPx((Number(bbox[0]) || 0) / 1000 * w, w)
  const y1 = clampPx((Number(bbox[1]) || 0) / 1000 * h, h)
  const x2 = clampPx((Number(bbox[2]) || 0) / 1000 * w, w)
  const y2 = clampPx((Number(bbox[3]) || 0) / 1000 * h, h)
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
}

/**
 * Accumulate the visible text out of an adapter chunk stream.
 *
 * A stream carries the same text twice: incrementally as `text-delta`, then
 * whole in the closing `block-end`. Adding both doubles every answer, so the
 * deltas win and `block-end` only fills in for adapters that skip them.
 */
export async function collectText(iterable) {
  let out = ''
  let reasoning = ''
  let sawDelta = false
  for await (const chunk of iterable) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      out += chunk.text
      sawDelta = true
    } else if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoning += chunk.text
    } else if (
      !sawDelta && chunk && chunk.type === 'block-end'
      && chunk.block && typeof chunk.block.text === 'string'
    ) {
      if (chunk.block.type === 'text') out += chunk.block.text
      else if (chunk.block.type === 'reasoning') reasoning += chunk.block.text
    } else if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const err = chunk.reason.failure
      throw new Error('LLM error (' + ((err && err.code) || 'ERROR') + '): ' + ((err && err.message) || 'stream failed'))
    }
  }
  return (out.trim() || reasoning.trim())
}

/** Non-cryptographic FNV-1a content hash (fast, no dependencies). */
export function contentHash(bytes) {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/**
 * Encode a 64-bit bit-string ('0'/'1' x64) as exact 16-char hex.
 * The value exceeds Number.MAX_SAFE_INTEGER, so it is packed as two exact
 * 32-bit halves instead of one rounding parseInt call (#199).
 */
export function bits64ToHex(bits) {
  const hi = parseInt(bits.slice(0, 32), 2)
  const lo = parseInt(bits.slice(32), 2)
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0')
}

/**
 * Perceptual hash (pHash) for image deduplication (#170).
 * Returns a 64-bit hex string. Similar images produce similar hashes.
 * ponytail: simple DCT-free implementation. Uses 8x8 average hash.
 */
export async function pHash(bytes) {
  const sharp = await loadSharp()
  if (!sharp) return contentHash(bytes)
  try {
    const { data } = await sharp(bytes).resize(8, 8, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true })
    const avg = data.reduce((a, b) => a + b, 0) / 64
    let hash = ''
    for (let i = 0; i < 64; i++) {
      hash += data[i] >= avg ? '1' : '0'
    }
    // 64 bits exceed Number.MAX_SAFE_INTEGER — pack as two exact halves (#199).
    return bits64ToHex(hash)
  } catch {
    return contentHash(bytes)
  }
}

/**
 * Check image quality (#157) — returns blur, lighting, overall score.
 */
export async function checkImageQuality(bytes) {
  const sharp = await loadSharp()
  if (!sharp) return { score: 0, blur: 'unknown', lighting: 0, note: 'sharp unavailable' }
  try {
    const stats = await sharp(bytes).stats()
    const channels = stats.channels
    const meanR = channels[0]?.mean || 128
    const meanG = channels[1]?.mean || 128
    const meanB = channels[2]?.mean || 128
    const lighting = Math.round(((meanR + meanG + meanB) / 3 / 255) * 100)
    const stdevR = channels[0]?.stdev || 0
    // Higher stdev = more detail = less blurry
    const blur = stdevR < 20 ? 'high' : stdevR < 40 ? 'medium' : 'low'
    const score = Math.min(100, Math.round(stdevR * 2 + (lighting > 20 && lighting < 80 ? 20 : 0)))
    return { score, blur, lighting, note: blur === 'high' ? 'image may be blurry' : 'ok' }
  } catch (e) {
    return { score: 0, blur: 'unknown', lighting: 0, note: String(e?.message || e) }
  }
}


export function extractSessionId(obj) {
  if (!obj || typeof obj !== 'object') return 'global'
  return String(
    obj.session?.id ||
    obj.session?.sessionId ||
    obj.sessionId ||
    obj.agent?.session?.id ||
    obj.agent?.id ||
    obj.agentId ||
    obj.caller ||
    'global'
  )
}

export class SessionScopedAttachmentMap extends Map {
  constructor() {
    super()
    this._sessions = new Map()
  }

  get(key, sessionId = 'global') {
    const sId = String(sessionId || 'global')
    if (sId !== 'global') {
      const sMap = this._sessions.get(sId)
      return sMap ? sMap.get(key) : undefined
    }
    return super.get(key)
  }

  has(key, sessionId = 'global') {
    const sId = String(sessionId || 'global')
    if (sId !== 'global') {
      const sMap = this._sessions.get(sId)
      return sMap ? sMap.has(key) : false
    }
    return super.has(key)
  }

  set(key, ref, sessionId = 'global') {
    const sId = String(sessionId || 'global')
    if (sId !== 'global') {
      let sMap = this._sessions.get(sId)
      if (!sMap) {
        if (this._sessions.size > 100) {
          const oldest = this._sessions.keys().next().value
          if (oldest !== undefined) this._sessions.delete(oldest)
        }
        sMap = new Map()
        this._sessions.set(sId, sMap)
      }
      sMap.delete(key)
      sMap.set(key, ref)
      if (sMap.size > 100) {
        const oldest = sMap.keys().next().value
        if (oldest !== undefined) sMap.delete(oldest)
      }
    }
    super.delete(key)
    super.set(key, ref)
    if (this.size > 300) {
      const oldest = this.keys().next().value
      if (oldest !== undefined) super.delete(oldest)
    }
    return this
  }

  delete(key, sessionId = 'global') {
    const sId = String(sessionId || 'global')
    if (sId !== 'global') {
      const sMap = this._sessions.get(sId)
      if (sMap) sMap.delete(key)
    }
    return super.delete(key)
  }

  getLast(sessionId = 'global') {
    const sId = String(sessionId || 'global')
    if (sId !== 'global') {
      const sMap = this._sessions.get(sId)
      if (!sMap || sMap.size === 0) return null
      return [...sMap.values()].pop() || null
    }
    return [...this.values()].pop() || null
  }

  values(sessionId = 'global') {
    const sId = String(sessionId || 'global')
    if (sId !== 'global') {
      const sMap = this._sessions.get(sId)
      return sMap ? sMap.values() : [][Symbol.iterator]()
    }
    return super.values()
  }

  clearSession(sessionId) {
    if (sessionId) {
      this._sessions.delete(String(sessionId))
    }
  }
}
