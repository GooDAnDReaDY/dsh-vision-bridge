import { bestEffort } from '../vision-core.js'
// #291: media & file upload domain routes
import { runProcessAsync } from '../process.js'
import { isTrustedSettingsRequest } from '../vision-core.js'

export function registerMediaRoutes(ctx, deps) {
  const { config, recordAttachment } = deps

  // POST /dsh-vision-bridge/upload-pdf
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-vision-bridge/upload-pdf',
      handler: async (req, res) => {
        const writeJson = (status, body) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (req.method !== 'POST') {
          writeJson(405, { error: 'method not allowed' })
          return
        }
        if (!isTrustedSettingsRequest(req)) {
          writeJson(403, { error: 'forbidden: same-origin only' })
          return
        }
        let pdfPath = null
        const frameFiles = []
        try {
          const declared = Number(req.headers['content-length'] || 0)
          if (declared > config.maxPdfBytes) {
            writeJson(413, { error: 'payload of ' + declared + ' bytes exceeds the ' + config.maxPdfBytes + ' limit' })
            return
          }
          const chunks = []
          let total = 0
          let tooLarge = false
          let drained = 0
          for await (const chunk of req) {
            total += chunk.length
            if (tooLarge) {
              drained += chunk.length
              if (drained > config.maxPdfBytes * 4) break
              continue
            }
            if (total > config.maxPdfBytes) { tooLarge = true; continue }
            chunks.push(chunk)
          }
          if (tooLarge) {
            writeJson(413, { error: 'payload exceeds the ' + config.maxPdfBytes + ' limit' })
            return
          }
          const buf = Buffer.concat(chunks)
          if (buf.length === 0) { writeJson(400, { error: 'empty payload' }); return }
          let pdfBytes = buf
          let docName = 'document.pdf'
          bestEffort('routes.media.base64Read', () => {
            const text = buf.toString('utf8')
            if (text.startsWith('{')) {
              const parsed = JSON.parse(text)
              if (parsed.base64) pdfBytes = Buffer.from(parsed.base64, 'base64')
              if (parsed.name) docName = parsed.name
            }
          })
          const { tmpdir } = await import('node:os')
          const { join } = await import('node:path')
          const { writeFileSync, readFileSync, readdirSync, existsSync } = await import('node:fs')
          const dir = tmpdir()
          const stem = 'vbpdf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
          pdfPath = join(dir, stem + '.pdf')
          writeFileSync(pdfPath, pdfBytes)
          const r = await runProcessAsync('pdftoppm', ['-png', '-r', '150', '-l', '10', pdfPath, join(dir, stem)], { timeout: 60000 })
          if (r.error && r.error.code === 'ENOENT') {
            writeJson(500, { error: 'pdftoppm is not installed on the system (please install poppler-utils)' })
            return
          }
          const frames = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(stem) && f.endsWith('.png')).sort() : []
          if (frames.length === 0) {
            writeJson(422, { error: 'failed to render PDF: ' + (r.stderr?.slice(0, 120) || 'no pages') })
            return
          }
          const pages = []
          for (let i = 0; i < frames.length; i++) {
            const frameFile = join(dir, frames[i])
            frameFiles.push(frameFile)
            const pageBytes = readFileSync(frameFile)
            const pageName = docName.replace(/\.pdf$/i, '') + '-page-' + (i + 1) + '.png'
            const savedRef = await ctx.attachments.saveImage({ data: pageBytes, mediaType: 'image/png', name: pageName })
            const id = savedRef.attachmentId ?? savedRef.id
            if (id !== undefined) recordAttachment(id, savedRef)
            pages.push({ attachmentId: String(id || ''), name: pageName, bytes: pageBytes.length, dataUrl: 'data:image/png;base64,' + pageBytes.toString('base64') })
          }
          writeJson(200, { ok: true, pages, count: pages.length })
        } catch (err) {
          writeJson(500, { error: String((err && err.message) || err) })
        } finally {
          await bestEffort('routes.media.cleanup', async () => {
            const { unlinkSync, existsSync } = await import('node:fs')
            if (pdfPath && existsSync(pdfPath)) unlinkSync(pdfPath)
            for (const f of frameFiles) {
              if (existsSync(f)) unlinkSync(f)
            }
          })
        }
      },
    }),
    'dsh-vision-bridge: /upload-pdf route'
  )
}
