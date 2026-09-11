// dsh-vision-bridge — tools: attach domain (#241 direction A).
//
// Media expansion for models that see images natively: PDF pages, video
// frames and local/remote images are published as conversation attachments
// so the CHAT model looks at the pixels itself instead of paying a second
// vision call for a description. These tools are useless for a text-only
// route (the model cannot see the attachment) and are denied there by the
// model-aware policy in lib/index.js.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { compressImage, isPathAllowed, isSafeFetchUrl, safeFetch, sniffMediaType, FETCH_POLICY_CODE } from '../vision-core.js'
import { runProcessAsync, isBinaryAvailable } from '../process.js'
import { existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** #241: hard ceiling for one attach call, independent of the setting. */
export const ATTACH_HARD_CAP = 32
/** Image extensions accepted from a directory scan. */
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i

/**
 * Canonical filesystem path for a resolved fs target (#246 review). The fs
 * service returns `{ targetKey, displayPath }`; reading `.path` silently
 * produced "[object Object]" for every binary invocation.
 */
export function resolvedPathOf(target, fs) {
  if (target === null || target === undefined) return ''
  if (typeof target === 'string') return target
  if (typeof target.path === 'string' && target.path) return target.path
  try {
    if (fs && typeof fs.processPath === 'function') {
      const out = fs.processPath(target)
      if (typeof out === 'string' && out) return out
    }
  } catch {}
  if (typeof target.displayPath === 'string' && target.displayPath) return target.displayPath
  return String(target)
}

/** Trim a list to the configured attach limit, reporting whether it was cut. */
export function trimToLimit(items, max) {
  const cap = Math.max(1, Math.min(ATTACH_HARD_CAP, Number(max) || 8))
  const list = Array.isArray(items) ? items : []
  return { kept: list.slice(0, cap), truncated: list.length > cap, cap }
}

/**
 * Fetch one remote image, enforce the SSRF policy and prove the body really is
 * an image. Kept separate from the tool so the size and content-type branches
 * are reachable in tests without a live network: `fetchImpl` defaults to the
 * policy layer and is only overridden by tests.
 */
export async function readRemoteImage(url, { fetchImpl = safeFetch, maxBytes = 20 * 1024 * 1024, timeoutMs, allowedHosts } = {}) {
  const res = await fetchImpl(url, {
    allowedHosts,
    init: { signal: AbortSignal.timeout(Math.max(1000, timeoutMs || 15000)) },
  })
  if (!res.ok) throw new Error(`vision_attach_images: GET ${url} -> ${res.status}`)
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new Error(`vision_attach_images: ${url} exceeds the ${maxBytes} byte limit`)
  const remoteType = String(res.headers.get('content-type') || '')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > maxBytes) throw new Error(`vision_attach_images: ${url} exceeds the ${maxBytes} byte limit`)
  // a generic content-type is fine when the bytes sniff as an image
  if (remoteType && !/^image\//i.test(remoteType) && !sniffMediaType(bytes)) {
    throw new Error(`vision_attach_images: ${url} is not an image (content-type ${remoteType.slice(0, 40)})`)
  }
  return { bytes, contentType: remoteType || sniffMediaType(bytes) || 'image/png' }
}

export function registerAttachTools(d) {
  const { ctx, config, attachmentById, recordAttachment } = d
  const capFor = (explicit) => Math.max(1, Math.min(ATTACH_HARD_CAP, Number(explicit) || Number(config.attachMaxItems) || 8))

  /** Publish bytes as conversation attachments; returns the model-facing ids. */
  const publish = async (items, max) => {
    const { kept, truncated, cap } = trimToLimit(items, max)
    const out = []
    const failed = []
    for (const item of kept) {
      let bytes = item.bytes
      let contentType = item.contentType || sniffMediaType(bytes) || 'image/png'
      if (!bytes || !bytes.length) { failed.push(item.name || 'item'); continue }
      try {
        const compressed = await compressImage(bytes, contentType, {
          maxWidth: config.imageMaxWidth || 1920,
          maxHeight: config.imageMaxHeight || 1080,
          quality: config.imageQuality || 80,
          format: config.imageFormat || 'auto',
        })
        if (compressed && compressed.bytes) {
          bytes = compressed.bytes
          contentType = compressed.contentType || contentType
        }
      } catch {}
      let ref = null
      try {
        ref = await ctx.attachments.saveImage({ data: bytes, mediaType: contentType, name: item.name || 'attachment' })
      } catch (err) {
        failed.push((item.name || 'item') + ': ' + String((err && err.message) || err).slice(0, 80))
        continue
      }
      const id = ref ? (ref.attachmentId ?? ref.id) : undefined
      if (id === undefined) { failed.push(item.name || 'item'); continue }
      recordAttachment(id, ref)
      out.push({ id: String(id), name: String(item.name || 'attachment'), bytes: bytes.length })
    }
    return { items: out, truncated, cap, failed }
  }

  /** Image blocks so the chat model sees the published attachments. */
  const renderAttachments = (v) => {
    const blocks = []
    for (const item of v.items || []) {
      const ref = attachmentById.get(String(item.id))
      if (ref) blocks.push({ type: 'image', attachment: ref })
    }
    if (v.note) blocks.push({ type: 'text', text: v.note })
    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
  }

  const outputSchema = (extra) => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'string' }, name: { type: 'string' }, bytes: { type: 'number' } },
          },
        },
        truncated: { type: 'boolean' },
        note: { type: 'string' },
        text: { type: 'string' },
        ...extra,
      },
    },
    render: (_a, v) => renderAttachments(v),
  })

  // ── PDF pages as attachments ────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'vision_attach_pages',
    description: 'Publish PDF pages as conversation attachments so the chat model can read the document itself. Caps the number of pages per call and, when pdftotext is available, also returns the document text layer. Requires pdftoppm (poppler-utils).',
    parameters: {
      path: { type: 'string', description: 'Local .pdf path' },
      pages: { type: 'string', description: 'Page range, e.g. "1-5" or "3" (optional, default from the first page up to the cap)' },
      maxItems: { type: 'number', description: 'Maximum pages to attach in this call (default from the plugin setting)' },
    },
    output: outputSchema({}),
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 60000,
    execute: async ({ path, pages, maxItems }) => {
      const fs = ctx.get('fs')
      if (!fs) throw new Error('vision_attach_pages: fs service unavailable')
      if (!isPathAllowed(path, config.allowedImageDirs)) throw new Error(`vision_attach_pages: path ${path} is outside the allowedImageDirs`)
      const cap = capFor(maxItems)
      const target = await fs.resolve(path)
      const pdfPath = resolvedPathOf(target, fs)
      const dir = tmpdir()
      const stem = `vbap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const parts = String(pages || '').match(/^\s*(\d+)\s*(?:-\s*(\d+))?/)
      const first = parts ? Number(parts[1]) || 1 : 1
      const requestedLast = parts && parts[2] ? Number(parts[2]) : first + cap - 1
      const last = Math.max(first, Math.min(requestedLast, first + cap - 1))
      // #260: the range is clamped before rendering, so publish() cannot see it.
      const rangeClamped = requestedLast > last
      const r = await runProcessAsync('pdftoppm', ['-png', '-r', '150', '-f', String(first), '-l', String(last), pdfPath, join(dir, stem)], { timeout: config.timeoutMs + 30000 })
      if (r.error && r.error.code === 'ENOENT') throw new Error('vision_attach_pages: pdftoppm is not installed (poppler-utils)')
      const frameRe = new RegExp('^' + stem + '-?\\d+\\.png$')
      let frames = existsSync(dir) ? readdirSync(dir).filter((f) => frameRe.test(f)).sort() : []
      if (frames.length === 0) throw new Error('vision_attach_pages: no pages rendered (' + String(r.stderr || '').slice(0, 120) + ')')
      let text = ''
      try {
        if (await isBinaryAvailable('pdftotext')) {
          const t = await runProcessAsync('pdftotext', ['-layout', '-f', String(first), '-l', String(last), pdfPath, '-'], { timeout: config.timeoutMs })
          text = String(t.stdout || '').slice(0, 12000)
        }
      } catch {}
      const items = []
      try {
        for (const f of frames) {
          const file = join(dir, f)
          items.push({ bytes: readFileSync(file), contentType: 'image/png', name: f.replace(stem + '-', 'page-') })
        }
      } finally {
        for (const f of frames) { try { unlinkSync(join(dir, f)) } catch {} }
      }
      const { items: published, truncated: publishTruncated, cap: usedCap, failed } = await publish(items, cap)
      const truncated = publishTruncated || rangeClamped
      const note = `attached ${published.length} page image(s) (cap ${usedCap}${truncated ? ', more pages available' : ''})`
        + (failed.length ? `\nSkipped ${failed.length}: ` + failed.join('; ') : '')
        + (text.trim() ? '\n\nText layer:\n' + text : '')
      return { items: published, truncated, note }
    },
  }))

  // ── Video frames as attachments ────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'vision_attach_frames',
    description: 'Sample frames from a local video (ffmpeg) and publish them as conversation attachments so the chat model can watch the video itself. Uniform sampling by default, scene-change detection on request.',
    parameters: {
      path: { type: 'string', description: 'Local video path' },
      frames: { type: 'number', description: 'Frames to sample (default from the plugin setting)' },
      sceneDetect: { type: 'boolean', description: 'Sample on scene changes instead of uniformly' },
    },
    output: outputSchema({}),
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 60000,
    execute: async ({ path, frames, sceneDetect }) => {
      const fs = ctx.get('fs')
      if (!fs) throw new Error('vision_attach_frames: fs service unavailable')
      if (!isPathAllowed(path, config.allowedImageDirs)) throw new Error(`vision_attach_frames: path ${path} is outside the allowedImageDirs`)
      const cap = capFor(frames)
      // #260: sampling is clamped by the cap, so publish() never sees the cut.
      const capClamped = Number(frames) > cap
      const target = await fs.resolve(path)
      const videoPath = resolvedPathOf(target, fs)
      const dir = tmpdir()
      const stem = `vbaf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const vf = sceneDetect ? "select='gt(scene,0.3)',setpts=N/FRAME_RATE/TB" : `fps=1/1,select='not(mod(n\\,${Math.max(1, Math.round(cap / 2))}))'`
      const r = await runProcessAsync('ffmpeg', ['-i', videoPath, '-vf', vf, '-frames:v', String(cap), '-y', join(dir, stem + '-%02d.jpg')], { timeout: config.timeoutMs + 30000 })
      if (r.error && r.error.code === 'ENOENT') throw new Error('vision_attach_frames: ffmpeg is not installed')
      const files = []
      for (let i = 1; i <= cap + 5; i++) {
        const f = join(dir, `${stem}-${String(i).padStart(2, '0')}.jpg`)
        if (existsSync(f)) files.push(f)
      }
      if (files.length === 0) throw new Error('vision_attach_frames: ffmpeg produced no frames (' + String(r.stderr || '').slice(0, 120) + ')')
      const items = []
      try {
        for (const f of files) items.push({ bytes: readFileSync(f), contentType: 'image/jpeg', name: f.split('/').pop() })
      } finally {
        for (const f of files) { try { unlinkSync(f) } catch {} }
      }
      const { items: published, truncated: publishTruncated, cap: usedCap, failed } = await publish(items, cap)
      const truncated = publishTruncated || capClamped
      return { items: published, truncated, note: `attached ${published.length} video frame(s) (cap ${usedCap}${truncated ? ', more frames sampled' : ''})` + (failed.length ? `\nSkipped ${failed.length}: ` + failed.join('; ') : '') }
    },
  }))

  // ── Local/remote images as attachments ─────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'vision_attach_images',
    description: 'Publish local image files, a directory of images, or remote image URLs as conversation attachments so the chat model can inspect them directly (optionally with a zoomed crop). Downscales oversized images and caps how many are attached per call.',
    parameters: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Local image file paths' },
      dirs: { type: 'array', items: { type: 'string' }, description: 'Directories scanned for image files' },
      urls: { type: 'array', items: { type: 'string' }, description: 'http(s) image URLs (fetch policy applies)' },
      maxItems: { type: 'number', description: 'Maximum attachments for this call (default from the plugin setting)' },
    },
    output: outputSchema({}),
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 30000,
    execute: async ({ paths, dirs, urls, maxItems }) => {
      const fs = ctx.get('fs')
      const cap = capFor(maxItems)
      const sources = []
      for (const p of Array.isArray(paths) ? paths : []) sources.push({ kind: 'path', value: String(p) })
      for (const d of Array.isArray(dirs) ? dirs : []) sources.push({ kind: 'dir', value: String(d) })
      for (const u of Array.isArray(urls) ? urls : []) sources.push({ kind: 'url', value: String(u) })
      if (sources.length === 0) throw new Error('vision_attach_images: pass paths, dirs or urls')
      const items = []
      // #258: a source that cannot be read must not abort the whole call — the
      // readable ones still attach and the rest are reported as skipped.
      const skipped = []
      const shortErr = (err) => String((err && err.message) || err).slice(0, 80)
      for (const src of sources) {
        if (items.length >= ATTACH_HARD_CAP) break
        if (src.kind === 'dir') {
          if (!fs) throw new Error('vision_attach_images: fs service unavailable')
          if (!isPathAllowed(src.value, config.allowedImageDirs)) throw new Error(`vision_attach_images: path ${src.value} is outside the allowedImageDirs`)
          const target = await fs.resolve(src.value)
          const dirPath = resolvedPathOf(target, fs)
          let names = []
          try { names = readdirSync(dirPath).filter((f) => IMAGE_RE.test(f)).sort() } catch {}
          for (const name of names) {
            const full = join(dirPath, name)
            try {
              if (!statSync(full).isFile()) continue
              const fileTarget = await fs.resolve(full)
              const bytes = await fs.readBytes(fileTarget, undefined, config.maxImageBytes)
              items.push({ bytes, name })
            } catch {}
            if (items.length >= ATTACH_HARD_CAP) break
          }
          continue
        }
        if (src.kind === 'path') {
          const label = src.value.split(/[\\/]/).pop() || src.value
          if (!fs) throw new Error('vision_attach_images: fs service unavailable')
          if (!isPathAllowed(src.value, config.allowedImageDirs)) throw new Error(`vision_attach_images: path ${src.value} is outside the allowedImageDirs`)
          try {
            const target = await fs.resolve(src.value)
            items.push({ bytes: await fs.readBytes(target, undefined, config.maxImageBytes), name: label })
          } catch (err) {
            skipped.push(label + ': ' + shortErr(err))
          }
          continue
        }
        if (!(await isSafeFetchUrl(src.value, { allowedHosts: config.allowedUrlHosts }))) {
          throw new Error(`vision_attach_images: URL refused by fetch policy: ${src.value}`)
        }
        const remoteLabel = src.value.split('/').pop() || 'remote-image'
        try {
          const { bytes, contentType } = await readRemoteImage(src.value, {
            // DI seam: defaults to the policy layer, overridable for tests/hosts.
            fetchImpl: d.fetchImpl,
            maxBytes: config.maxImageBytes,
            timeoutMs: config.channelTimeoutMs,
            allowedHosts: config.allowedUrlHosts,
          })
          items.push({ bytes, contentType, name: remoteLabel })
        } catch (err) {
          // A policy refusal (including on a redirect hop) is a guard, not a
          // read failure: re-throw it so it cannot be downgraded to a skip.
          if (err && err.code === FETCH_POLICY_CODE) throw err
          skipped.push(remoteLabel + ': ' + shortErr(err))
        }
      }
      const { items: published, truncated, cap: usedCap, failed: publishFailed } = await publish(items, cap)
      const failed = skipped.concat(publishFailed)
      if (published.length === 0) {
        throw new Error('vision_attach_images: nothing to attach (no readable images found' + (failed.length ? '; skipped ' + failed.join('; ') : '') + ')')
      }
      return { items: published, truncated, note: `attached ${published.length} image(s) (cap ${usedCap}${truncated ? ', more sources available' : ''})` + (failed.length ? `\nSkipped ${failed.length}: ` + failed.join('; ') : '') }
    },
  }))
}
