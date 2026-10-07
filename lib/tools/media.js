export async function captureHtmlScreenshot({ chromePath, htmlPath, width = 1280, fullPage = false, timeoutMs = 30000 }) {
  const chrome = chromePath || process.env.CHROME_PATH || '/usr/bin/google-chrome'
  const targetWidth = Number(width) || 1280

  if (!fullPage) {
    const out = join(tmpdir(), `vbshot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`)
    const args = ['--headless', '--disable-gpu', '--no-sandbox', '--screenshot=' + out, `--window-size=${targetWidth},1024`, '--hide-scrollbars', 'file://' + htmlPath]
    const r = await runProcessAsync(chrome, args, { timeout: timeoutMs })
    if (!existsSync(out) || r.code !== 0) {
      const err = r.stderr?.split('\n')[0] || `chrome exited ${r.code}`
      throw new Error('html_screenshot failed: ' + String(err).slice(0, 200))
    }
    const bytes = readFileSync(out)
    bestEffort('media.unlinkViewportShot', () => unlinkSync(out))
    return bytes
  }

  // fullPage: true — launch Chrome with CDP, evaluate document scrollHeight and capture beyond viewport
  const profileDir = join(tmpdir(), `chrome-p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  const { mkdirSync, rmSync } = await import('node:fs')
  const { spawn } = await import('node:child_process')
  mkdirSync(profileDir, { recursive: true })

  const proc = spawn(chrome, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    `--window-size=${targetWidth},1024`,
    '--hide-scrollbars',
    'file://' + htmlPath,
  ])

  try {
    let wsUrl = ''
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for DevTools URL')), 7000)
      proc.stderr.on('data', (d) => {
        const m = d.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/)
        if (m) {
          wsUrl = m[1]
          clearTimeout(timer)
          resolve()
        }
      })
      proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    })

    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = reject
    })

    let id = 1
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const msgId = id++
        const handler = (event) => {
          const data = JSON.parse(event.data)
          if (data.id === msgId) {
            ws.removeEventListener('message', handler)
            if (data.error) reject(new Error(JSON.stringify(data.error)))
            else resolve(data.result)
          }
        }
        ws.addEventListener('message', handler)
        ws.send(JSON.stringify({ id: msgId, method, params }))
      })
    }

    const { targetInfos } = await send('Target.getTargets')
    const pageTarget = targetInfos?.find((t) => t.type === 'page')
    let pageSessionId
    if (pageTarget) {
      const attached = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true })
      pageSessionId = attached?.sessionId
    }

    function sendPage(method, params = {}) {
      if (pageSessionId) {
        return new Promise((resolve, reject) => {
          const msgId = id++
          const handler = (event) => {
            const data = JSON.parse(event.data)
            if (data.id === msgId) {
              ws.removeEventListener('message', handler)
              if (data.error) reject(new Error(JSON.stringify(data.error)))
              else resolve(data.result)
            }
          }
          ws.addEventListener('message', handler)
          ws.send(JSON.stringify({ id: msgId, sessionId: pageSessionId, method, params }))
        })
      }
      return send(method, params)
    }

    await sendPage('Page.enable')
    await new Promise((r) => setTimeout(r, 200))

    const evalRes = await sendPage('Runtime.evaluate', {
      expression: 'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 1024)',
      returnByValue: true,
    })
    const docHeight = Math.ceil(evalRes?.result?.value || 1024)

    const shot = await sendPage('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: targetWidth, height: docHeight, scale: 1 },
    })

    bestEffort('media.wsClose', () => ws.close())
    proc.kill('SIGKILL')
    await new Promise((r) => proc.on('exit', r))
    await new Promise((r) => setTimeout(r, 50))
    bestEffort('media.rmProfile', () => rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

    return Buffer.from(shot.data, 'base64')
  } catch (err) {
    proc.kill()
    bestEffort('media.rmProfileErr', () => rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    throw err
  }
}

import { bestEffort } from '../vision-core.js'
// dsh-vision-bridge — tools: media domain (#206).
// Registrations moved verbatim from lib/index.js apply(); closure state
// arrives via the deps object `d`.

import { resolvedPathOf } from './attach.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  isSafeFetchUrl,
  isPathAllowed,
} from '../vision-core.js'
import { runProcessAsync, isBinaryAvailable } from '../process.js'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function registerMediaTools(d) {
const { ctx, config, attachmentById, descriptionByAttachmentId, descriptionByHash, batches, startBatch, callVisionModelWithBytes, visionSelection, resolveImageBytes, resolveSourceBytes, collectText, describeImage, effectivePrompt, liveChannels, groundingPrompt, parseBbox, tesseractAvailable } = d

ctx.tools.register(defineTool({
    name: 'vision_html_screenshot', description: 'Render local HTML → PNG screenshot → publish as attachment.',
    parameters: { path: { type: 'string', description: 'local .html file path' }, width: { type: 'number', description: 'viewport width, default 1280' }, fullPage: { type: 'boolean', description: 'capture full page, default false' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string' }, attachmentId: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.note}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ path, width, fullPage }) => {
      const fs = ctx.get('fs'); if (!fs) throw new Error('vision_html_screenshot: fs unavailable');
      const target = await fs.resolve(path);
      const htmlPath = resolvedPathOf(target, fs);
      const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome'
      try {
        const bytes = await captureHtmlScreenshot({
          chromePath: chrome,
          htmlPath,
          width: width || 1280,
          fullPage: Boolean(fullPage),
          timeoutMs: config.timeoutMs + 15000,
        })
        const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'vision-html.png' })
        return { note: 'screenshot rendered', attachmentId: String(ref.attachmentId ?? ref.id ?? '') }
      } catch (err) {
        return { note: 'html_screenshot failed: ' + String(err?.message || err).slice(0, 200), attachmentId: '' }
      }
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_materialize', description: 'Copy an authorized attachment into session workspace, return filesystem path.',
    parameters: { attachmentId: { type: 'string' }, filename: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.path}] } },
    isConcurrencySafe: () => false, timeoutMs: 30000,
    execute: async ({ attachmentId, filename }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_materialize: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_materialize: cannot read');
      const fs = ctx.get('fs'); if (!fs) throw new Error('vision_materialize: fs unavailable');
      const cleanId = String(attachmentId).replace(/^sha256:/, '').slice(0, 12);
      const safeName = String(filename || `vision-${cleanId}.png`).replace(/[^\w.\-]+/g, '_').slice(0, 100);
      const target = await fs.resolve(safeName);
      const targetPath = String(target.path ?? target ?? safeName);
      if (typeof fs.writeBytes === 'function') {
        await fs.writeBytes(target, src.bytes);
      } else {
        if (!isPathAllowed(targetPath, config.allowedImageDirs)) {
          throw new Error('vision_materialize: path outside allowedImageDirs: ' + targetPath);
        }
        const { writeFileSync } = await import('node:fs');
        writeFileSync(targetPath, src.bytes);
      }
      return { path: targetPath };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_video_describe', description: 'Describe video content — extract frames (ffmpeg) → vision LLM → summary.',
    parameters: { path: { type: 'string' }, question: { type: 'string' }, frames: { type: 'number', description: 'frames to sample, default 6' }, sceneDetect: { type: 'boolean', description: 'Use scene change detection instead of uniform sampling', default: false } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { description: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.description}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 60000,
    execute: async ({ path, question, frames, sceneDetect }) => {
      const fs = ctx.get('fs'); if (!fs) throw new Error('vision_video_describe: fs unavailable');
      const target = await fs.resolve(path);
      const videoPath = resolvedPathOf(target, fs);
      const n = Math.max(2, Math.min(12, Number(frames) || 6));
      const dir = tmpdir(); const stem = `vbf-${Date.now()}`;
      const vf = sceneDetect ? "select='gt(scene,0.3)',setpts=N/FRAME_RATE/TB" : `fps=1/1,select='not(mod(n\,${n}))'`
      const r = await runProcessAsync('ffmpeg', ['-i', videoPath, '-vf', vf, '-frames:v', String(n), '-y', join(dir, stem + '-%02d.jpg')], { timeout: config.timeoutMs + 30000 })
      // Fallback: sample N frames regardless of exact fps.
      const outFrames = []
      for (let i = 1; i <= n; i++) { const f = join(dir, `${stem}-${String(i).padStart(2, '0')}.jpg`); if (existsSync(f)) outFrames.push(f) }
      if (outFrames.length === 0) return { description: `video describe failed: ffmpeg produced no frames (${r.stderr?.slice(0,120)})` }
      // Describe each frame via the bridge, then join into a summary.
      const per = []
      for (const f of outFrames) {
        const bytes = readFileSync(f); bestEffort('media.unlinkFrame', () => unlinkSync(f))
        const { description } = await callVisionModelWithBytes(bytes, 'image/jpeg', question || 'Describe this video frame briefly.', {})
        per.push(description || '')
      }
      return { description: per.join('\n') }
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_page_persist', description: 'Screenshot a URL page → publish as attachment (headless Chrome).',
    parameters: { url: { type: 'string' }, width: { type: 'number', description: 'viewport width, default 1280' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string' }, attachmentId: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.note}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ url, width }) => {
      // #202-review: headless chrome fetches on its own, so the model-supplied
      // URL is checked before launch (chrome resolves DNS itself — the
      // documented TOCTOU limitation applies; see DESIGN.md).
      if (!(await isSafeFetchUrl(url, { allowedHosts: config.allowedUrlHosts }))) {
        return { note: 'page_persist refused by fetch policy (#202): ' + url, attachmentId: '' }
      }
      const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome'
      const out = join(tmpdir(), `vbpage-${Date.now()}.png`)
      const r = await runProcessAsync(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--screenshot=${out}`, `--window-size=${width || 1280},1024`, '--virtual-time-budget=5000', String(url)], { timeout: config.timeoutMs + 30000 })
      if (!existsSync(out)) {
        const err = r.stderr?.split('\n')[0] || `chrome exited ${r.code}`
        return { note: 'page_persist failed: ' + String(err).slice(0, 200), attachmentId: '' }
      }
      const bytes = readFileSync(out); bestEffort('media.unlink', () => unlinkSync(out))
      const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'vision-page.png' })
      return { note: 'page screenshot published', attachmentId: String(ref.attachmentId ?? ref.id ?? '') }
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_browser_snapshot', description: 'Fetch a URL and return its rendered text content (headless Chrome --dump-dom → text).',
    parameters: { url: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { snapshot: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.snapshot.slice(0,2000)}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ url }) => {
      // #202-review: same pre-launch policy check as vision_page_persist.
      if (!(await isSafeFetchUrl(url, { allowedHosts: config.allowedUrlHosts }))) {
        return { snapshot: 'browser_snapshot refused by fetch policy (#202): ' + url }
      }
      const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome'
      const r = await runProcessAsync(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--dump-dom', '--virtual-time-budget=5000', String(url)], { timeout: config.timeoutMs + 30000, maxBuffer: 20 * 1024 * 1024 })
      if (!r.stdout) return { snapshot: `browser_snapshot failed for ${url}` }
      // Strip tags crudely — the model needs text, not markup.
      const text = String(r.stdout).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return { snapshot: text }
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_batch', description: 'Process N images in parallel with the same prompt. Returns per-item results; progress is tracked server-side (see /batch).',
    parameters: { attachmentIds: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, description: { type: 'string' }, error: { type: 'string' } } } } } }, render(_a,v){ return [{type:'text',text: JSON.stringify(v.results, null, 2)}] } },
    isConcurrencySafe: () => true, timeoutMs: config.timeoutMs * 3,
    execute: async ({ attachmentIds, prompt }, exec) => {
      if (exec?.signal?.aborted) {
        const err = new Error('vision_batch: operation aborted')
        err.name = 'AbortError'
        throw err
      }
      if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) throw new Error('vision_batch: attachmentIds required')
      // #110, #397: run through the batch manager so progress/cancel are available.
      const items = []
      for (const id of attachmentIds) {
        const ref = attachmentById.get(String(id)); if (!ref) throw new Error(`vision_batch: unknown ${id}`)
        const src = await resolveImageBytes(ref); if (!src) throw new Error(`vision_batch: cannot read ${id}`)
        items.push({ id, bytes: src.bytes, contentType: src.contentType })
      }
      if (exec?.signal?.aborted) {
        const err = new Error('vision_batch: operation aborted')
        err.name = 'AbortError'
        throw err
      }
      const bid = await startBatch(items, prompt)
      const b = batches.get(bid)
      const onAbort = () => {
        if (b && b.ctrl && !b.ctrl.signal.aborted) {
          b.ctrl.abort(exec?.signal?.reason)
        }
      }
      if (exec?.signal) {
        exec.signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        await new Promise((resolve, reject) => {
          const poll = () => {
            if (exec?.signal?.aborted) {
              const err = new Error('vision_batch: operation aborted')
              err.name = 'AbortError'
              return reject(err)
            }
            if (!b || b.state?.finishedAt || b.state?.cancelled) return resolve()
            setTimeout(poll, 100)
          }
          poll()
        })
      } finally {
        if (exec?.signal) {
          exec.signal.removeEventListener('abort', onAbort)
        }
      }
      return { results: b?.state?.results || [] }
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_verify_generated_image',
    description: 'Verify and inspect an AI-generated image (from dsh-image-gen or workspace) for quality, artifacts, and text accuracy.',
    parameters: {
      path: { type: 'string', description: 'Path to generated image file' },
      attachmentId: { type: 'string', description: 'Attachment ID of image' },
      prompt: { type: 'string', description: 'Original prompt or expected visual contents' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          score: { type: 'number' },
          passed: { type: 'boolean' },
          critique: { type: 'string' },
          detectedElements: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: 'Quality Score: ' + v.score + '/100 (' + (v.passed ? 'PASSED' : 'NEEDS REVISION') + ')\n\n' + v.critique }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 20000,
    execute: async ({ path, attachmentId, prompt: expectedPrompt }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_verify_generated_image: image file not found');
      const p = 'Inspect this AI-generated image against the intended prompt: "' + (expectedPrompt || 'N/A') + '". '
        + 'Check for visual artifacts, anatomical accuracy, text legibility, composition, and style fidelity. '
        + 'Reply with strict JSON {"score":number(0-100),"passed":boolean,"critique":"detailed assessment and advice","detectedElements":["elem1","elem2"]}.';
      const { description, warnings: prepWarnings = [] } = await callVisionModelWithBytes(src.bytes, src.contentType, p, { ...(exec ? { signal: exec.signal } : {}) });
      const parsed = bestEffort('vision_verify_generated_image.parse', () => JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''), null);
      const warnings = [...prepWarnings];
      if (!parsed) warnings.push('Failed to parse critique JSON from vision response; critique populated from raw output');

      let score = 0;
      let passed = false;
      const rawScore = parsed?.score;
      if (parsed && typeof rawScore === 'number' && !Number.isNaN(rawScore) && rawScore >= 0 && rawScore <= 100) {
        score = Math.round(rawScore);
        if (typeof parsed.passed === 'boolean') {
          passed = parsed.passed;
        } else if (parsed.passed === 'true') {
          passed = true;
        } else if (parsed.passed === 'false') {
          passed = false;
        } else {
          passed = score >= 75;
        }
      } else if (!parsed) {
        score = 0;
        passed = false;
      }

      return {
        score,
        passed,
        critique: String(parsed?.critique || description || ''),
        detectedElements: Array.isArray(parsed?.detectedElements) ? parsed.detectedElements.map(String) : [],
        warnings,
      };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_export_report', description: 'Export vision pipeline results to formatted Markdown or PDF report.',
    parameters: {
      title: { type: 'string', description: 'Report title', default: 'Vision Analysis Report' },
      attachmentIds: { type: 'array', items: { type: 'string' }, description: 'List of attachment IDs to include' },
      results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { attachmentId: { type: 'string' }, tool: { type: 'string' }, content: { type: 'string' } } }, description: 'Vision tool results to include' },
      format: { type: 'string', description: "Output format: 'markdown' (default) or 'pdf'" },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string' },
          format: { type: 'string' },
          filename: { type: 'string' },
          mediaType: { type: 'string' },
          attachmentId: { type: 'string' },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: v.format === 'pdf' ? `Exported PDF report (${v.filename})` : v.report }]
      },
    },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ title, attachmentIds, results, format }) => {
      const fmt = (format || 'markdown').toLowerCase()
      if (fmt !== 'markdown' && fmt !== 'pdf') {
        throw new Error(`vision_export_report: unsupported format '${format}'; supported formats are 'markdown' and 'pdf'`)
      }
      const ts = new Date().toISOString()
      const reportTitle = title || 'Vision Analysis Report'
      let md = `# ${reportTitle}\n\n`
      md += `**Generated:** ${ts}\n`
      md += `**Format:** ${fmt}\n\n`
      md += `## Summary\n\n`
      md += `- Attachments analyzed: ${(attachmentIds || []).length}\n`
      md += `- Tool results: ${(results || []).length}\n\n`

      const embeddedImages = []
      if (attachmentIds && attachmentIds.length > 0) {
        md += `## Images\n\n`
        for (const id of attachmentIds) {
          md += `### Attachment: ${id}\n\n`
          const ref = attachmentById.get(String(id))
          if (ref) {
            try {
              const src = await resolveImageBytes(ref)
              if (src) {
                const b64 = src.bytes.toString('base64')
                const dataUri = `data:${src.contentType};base64,${b64}`
                md += `![${id}](${dataUri})\n\n`
                embeddedImages.push({ id, dataUri })
              }
            } catch (err) { if (typeof console !== 'undefined' && console.debug) console.debug('[dsh-vision-bridge] embed image bytes fallback:', err?.message || err) }
          }
        }
      }
      if (results && results.length > 0) {
        md += `## Results\n\n`
        for (const r of results) {
          md += `### ${r.tool || 'analysis'} — ${r.attachmentId || 'unknown'}\n\n`
          md += `${r.content || ''}\n\n---\n\n`
        }
      }

      if (fmt === 'markdown') {
        return {
          report: md,
          format: 'markdown',
          filename: 'report.md',
          mediaType: 'text/markdown',
        }
      }

      // format === 'pdf'
      const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome'
      const hasChrome = await isBinaryAvailable(chrome)
      if (!hasChrome) {
        throw new Error("vision_export_report: format 'pdf' is unsupported on this host (headless Chrome/Chromium not available)")
      }

      const inHtml = join(tmpdir(), `vbrp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.html`)
      const outPdf = join(tmpdir(), `vbrp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.pdf`)

      const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(reportTitle)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 36px; color: #1f2937; line-height: 1.5; }
h1 { color: #111827; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
h2 { color: #374151; margin-top: 24px; }
h3 { color: #4b5563; margin-top: 16px; }
pre { background: #f3f4f6; padding: 12px; border-radius: 6px; white-space: pre-wrap; font-family: monospace; font-size: 13px; }
img { max-width: 100%; border-radius: 6px; margin: 8px 0; border: 1px solid #e5e7eb; }
hr { border: 0; border-top: 1px solid #e5e7eb; margin: 20px 0; }
ul { padding-left: 20px; }
</style>
</head>
<body>
<h1>${escapeHtml(reportTitle)}</h1>
<p><strong>Generated:</strong> ${ts}</p>
<p><strong>Format:</strong> pdf</p>
<h2>Summary</h2>
<ul>
<li>Attachments analyzed: ${(attachmentIds || []).length}</li>
<li>Tool results: ${(results || []).length}</li>
</ul>
${embeddedImages.length > 0 ? `<h2>Images</h2>` + embeddedImages.map((img) => `<h3>Attachment: ${escapeHtml(img.id)}</h3><img src="${img.dataUri}" />`).join('') : ''}
${results && results.length > 0 ? `<h2>Results</h2>` + results.map((r) => `<h3>${escapeHtml(r.tool || 'analysis')} — ${escapeHtml(r.attachmentId || 'unknown')}</h3><pre>${escapeHtml(r.content || '')}</pre><hr>`).join('') : ''}
</body>
</html>`

      try {
        writeFileSync(inHtml, htmlContent, 'utf8')
        const r = await runProcessAsync(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--print-to-pdf=' + outPdf, 'file://' + inHtml], { timeout: config.timeoutMs + 20000 })
        if (!existsSync(outPdf) || r.code !== 0) {
          throw new Error('vision_export_report: PDF generation failed: ' + (r.stderr?.split('\n')[0] || `chrome exited ${r.code}`))
        }
        const pdfBytes = readFileSync(outPdf)
        if (!pdfBytes.subarray(0, 4).equals(Buffer.from('%PDF'))) {
          throw new Error('vision_export_report: generated file does not contain valid PDF header')
        }

        let publishedId = ''
        if (ctx.attachments && typeof ctx.attachments.saveImage === 'function') {
          const ref = await ctx.attachments.saveImage({ data: pdfBytes, mediaType: 'application/pdf', name: 'report.pdf' })
          publishedId = String(ref?.attachmentId ?? ref?.id ?? '')
        }

        return {
          report: pdfBytes.toString('base64'),
          format: 'pdf',
          filename: 'report.pdf',
          mediaType: 'application/pdf',
          ...(publishedId ? { attachmentId: publishedId } : {}),
        }
      } finally {
        bestEffort('media.unlinkPdfTmp', () => {
          if (existsSync(inHtml)) unlinkSync(inHtml)
          if (existsSync(outPdf)) unlinkSync(outPdf)
        })
      }
    },
  }))

}
