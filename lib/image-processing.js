// dsh-vision-bridge — image preprocessing & optimization pipeline
import { compressImage, deskewImage, enhanceImage, stripEXIF, imageDimensions, sniffMediaType } from './vision-core.js'

/**
 * Smartly optimizes image bytes before sending them to vision models:
 *  - Strips EXIF metadata if configured
 *  - Applies deskewing / auto-enhancement if enabled
 *  - Downscales oversized images preserving aspect ratio
 *  - Compresses heavy images to reduce latency and token usage
 */
export async function smartOptimizeImage(bytes, contentType, options = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return { bytes, contentType: contentType || 'image/png', optimized: false }
  }

  let currentBytes = bytes
  let currentType = contentType || sniffMediaType(bytes) || 'image/png'
  let modified = false

  const {
    maxWidth = 1920,
    maxHeight = 1080,
    quality = 80,
    stripExifFlag = false,
    deskewFlag = false,
    enhanceFlag = false,
  } = options

  // 1. Strip EXIF if requested
  if (stripExifFlag) {
    try {
      const stripped = stripEXIF(currentBytes)
      if (stripped && stripped.length > 0 && stripped.length !== currentBytes.length) {
        currentBytes = stripped
        modified = true
      }
    } catch {}
  }

  // 2. Deskew if requested
  if (deskewFlag) {
    try {
      const deskewed = await deskewImage(currentBytes)
      if (deskewed && deskewed.length > 0) {
        currentBytes = deskewed
        modified = true
      }
    } catch {}
  }

  // 3. Enhance if requested
  if (enhanceFlag) {
    try {
      const enhanced = await enhanceImage(currentBytes)
      if (enhanced && enhanced.length > 0) {
        currentBytes = enhanced
        modified = true
      }
    } catch {}
  }

  // 4. Check dimensions and compress if oversized
  try {
    const dims = imageDimensions(currentBytes)
    if (dims && (dims.width > maxWidth || dims.height > maxHeight || currentBytes.length > 2 * 1024 * 1024)) {
      const compressed = await compressImage(currentBytes, { maxWidth, maxHeight, quality })
      if (compressed && compressed.length > 0 && compressed.length < currentBytes.length) {
        currentBytes = compressed
        modified = true
      }
    }
  } catch {}

  return {
    bytes: currentBytes,
    contentType: currentType,
    optimized: modified,
    size: currentBytes.length,
  }
}
