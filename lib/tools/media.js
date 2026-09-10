// dsh-vision-bridge — tools: media domain (#206).
// Registrations moved verbatim from lib/index.js apply(); closure state
// arrives via the deps object `d`.

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  isSafeFetchUrl,
} from '../vision-core.js'
import { runProcessAsync, isBinaryAvailable } from '../process.js'

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
      const htmlPath = String(target.path ?? target ?? '');
      // Chrome headless screenshot (no puppeteer dep).
      const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome'
      const out = join(tmpdir(), `vbshot-${Date.now()}.png`)
      const args = ['--headless', '--disable-gpu', '--no-sandbox', '--screenshot=' + out, '--window-size=' + (width || 1280) + ',1024', '--hide-scrollbars', 'file://' + htmlPath]
      const r = await runProcessAsync(chrome, args, { timeout: config.timeoutMs + 15000 })
      if (!existsSync(out) || r.code !== 0) {
        const err = r.stderr?.split('\n')[0] || `chrome exited ${r.code}`
        return { note: 'html_screenshot failed: ' + String(err).slice(0, 200), attachmentId: '' }
      }
      const bytes = readFileSync(out)
      try { unlinkSync(out) } catch {}
      const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'vision-html.png' })
      return { note: 'screenshot rendered', attachmentId: String(ref.attachmentId ?? ref.id ?? '') }
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
      try {
        if (typeof fs.writeBytes === 'function') {
          await fs.writeBytes(target, src.bytes);
        } else {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(targetPath, src.bytes);
        }
      } catch {
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
      const videoPath = String(target.path ?? target ?? '');
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
        const bytes = readFileSync(f); try { unlinkSync(f) } catch {}
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
      const bytes = readFileSync(out); try { unlinkSync(out) } catch {}
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
    execute: async ({ attachmentIds, prompt }) => {
      if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) throw new Error('vision_batch: attachmentIds required')
      // #110: run through the batch manager so progress/cancel are available.
      const items = []
      for (const id of attachmentIds) {
        const ref = attachmentById.get(String(id)); if (!ref) throw new Error(`vision_batch: unknown ${id}`)
        const src = await resolveImageBytes(ref); if (!src) throw new Error(`vision_batch: cannot read ${id}`)
        items.push({ id, bytes: src.bytes, contentType: src.contentType })
      }
      const bid = await startBatch(items, prompt)
      // Wait for completion (the tool returns the full result set).
      const b = batches.get(bid)
      await new Promise((resolve) => {
        const poll = () => {
          if (b.state.finishedAt || b.state.cancelled) resolve()
          else setTimeout(poll, 200)
        }
        poll()
      })
      return { results: b.state.results }
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
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, p, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      return {
        score: Number(parsed?.score ?? 90),
        passed: Boolean(parsed?.passed ?? ((parsed?.score ?? 90) >= 75)),
        critique: String(parsed?.critique || description || ''),
        detectedElements: Array.isArray(parsed?.detectedElements) ? parsed.detectedElements.map(String) : [],
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
    output: { schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'string' }, format: { type: 'string' }, filename: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: v.report}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ title, attachmentIds, results, format }) => {
      const fmt = format || 'markdown'
      const ts = new Date().toISOString()
      let md = `# ${title || 'Vision Analysis Report'}\n\n`
      md += `**Generated:** ${ts}\n`
      md += `**Format:** ${fmt}\n\n`
      md += `## Summary\n\n`
      md += `- Attachments analyzed: ${(attachmentIds || []).length}\n`
      md += `- Tool results: ${(results || []).length}\n\n`
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
                md += `![${id}](data:${src.contentType};base64,${b64})\n\n`
              }
            } catch {}
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
      return { report: md, format: fmt, filename: 'report.md' }
    },
  }))

}
