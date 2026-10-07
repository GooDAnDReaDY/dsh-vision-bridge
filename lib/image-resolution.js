import { extractSessionId, safeFetch, sniffMediaType, isPathAllowed } from './vision-core.js'
import { getPluginLogger } from './logger.js'

export function createImageResolver(deps) {
  const { ctx, config, attachmentById, logger = getPluginLogger() } = deps

  async function resolveImageBytes(refOrPath) {
    if (refOrPath && typeof refOrPath === 'object' && (refOrPath.attachmentId || refOrPath.id)) {
      const r = refOrPath
      let s
      try {
        s = await ctx.attachments.readImage(r)
      } catch (_err) {
        return null
      }
      return { bytes: s.data, contentType: r.mediaType || s.ref?.mediaType || 'image/png', ref: r }
    }
    return null
  }

  async function resolveSourceBytes(source, attachmentId, path, exec) {
    const sessionId = extractSessionId(exec)
    const src = String(source || attachmentId || path || '').trim()
    if (!src) {
      const lastRef = attachmentById.getLast(sessionId)
      if (lastRef) {
        try {
          const stored = await ctx.attachments.readImage(lastRef)
          return { bytes: stored.data, contentType: lastRef.mediaType || 'image/png' }
        } catch (err) {
          logger.debug('[dsh-vision-bridge] readImage fallback:', err?.message || err)
        }
      }
      return null
    }
    if (/^https?:\/\//i.test(src)) {
      try {
        const res = await safeFetch(src, {
          allowedHosts: config.allowedUrlHosts,
          init: { signal: AbortSignal.timeout(Math.max(1000, config.channelTimeoutMs || 15000)) },
        })
        if (!res.ok) return null
        const declared = Number(res.headers.get('content-length') || 0)
        if (declared > config.maxImageBytes) return null
        const bytes = Buffer.from(await res.arrayBuffer())
        if (bytes.length > config.maxImageBytes) return null
        return { bytes, contentType: res.headers.get('content-type') || sniffMediaType(bytes) || 'image/png' }
      } catch (_err) {
        return null
      }
    }
    if (attachmentById.has(src, sessionId)) {
      try {
        const ref = attachmentById.get(src, sessionId)
        const stored = await ctx.attachments.readImage(ref)
        return { bytes: stored.data, contentType: ref.mediaType || 'image/png' }
      } catch (_err) {
        return null
      }
    }
    if (!isPathAllowed(src, config.allowedImageDirs)) return null
    const dshFs = ctx.get('fs')
    if (dshFs) {
      try {
        const target = await dshFs.resolve(src)
        const targetPath = String(target?.path ?? target ?? src)
        if (!isPathAllowed(targetPath, config.allowedImageDirs)) return null
        const bytes = await dshFs.readBytes(target, undefined, config.maxImageBytes)
        return { bytes, contentType: sniffMediaType(bytes) || 'image/png' }
      } catch (err) {
        logger.debug('[dsh-vision-bridge] dshFs readBytes fallback:', err?.message || err)
      }
    }
    try {
      const { existsSync, readFileSync } = await import('node:fs')
      if (existsSync(src)) {
        const bytes = readFileSync(src)
        return { bytes, contentType: sniffMediaType(bytes) || 'image/png' }
      }
    } catch (err) {
      logger.debug('[dsh-vision-bridge] local file read fallback:', err?.message || err)
    }
    return null
  }

  return { resolveImageBytes, resolveSourceBytes }
}
