// dsh-vision-bridge — tools: ocr domain (#206).
// Registrations moved verbatim from lib/index.js apply(); closure state
// arrives via the deps object `d`.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { runProcessAsync, isBinaryAvailable } from '../process.js'

export function registerOcrTools(d) {
const { ctx, config, attachmentById, descriptionByAttachmentId, descriptionByHash, batches, startBatch, callVisionModelWithBytes, visionSelection, resolveImageBytes, resolveSourceBytes, collectText, describeImage, effectivePrompt, liveChannels, groundingPrompt, parseBbox, tesseractAvailable } = d

ctx.tools.register(defineTool({
    name: 'vision_ocr', description: 'OCR — transcribe text from an image. Supports multiple engines and output formats.',
    parameters: {
      attachmentId: { type: 'string' },
      lang: { type: 'string', description: 'language hint e.g. eng+chi_sim' },
      engine: { type: 'string', description: 'OCR engine: auto (default; local tesseract when installed, otherwise the vision LLM), tesseract (local only). Any other value, incl. legacy paddleocr/native, falls back to the vision LLM.' },
      format: { type: 'string', description: 'output format: text (default), markdown, html' },
      schema: { type: 'object', description: 'JSON Schema for structured extraction (overrides format)', additionalProperties: true },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, engine: { type: 'string' }, format: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.text}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, lang, engine, format, schema }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_ocr: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_ocr: cannot read image');

      // Engine selection: auto tries tesseract first, then falls back to vision LLM
      const useEngine = engine || 'auto'
      let result = ''
      let usedEngine = 'vision-llm'

      if (useEngine === 'tesseract' || (useEngine === 'auto' && (await tesseractAvailable()))) {
        try {
          const tmpFile = join(tmpdir(), `vbocr-${Date.now()}.png`)
          writeFileSync(tmpFile, src.bytes)
          const args = [tmpFile, 'stdout', '-l', (lang || 'eng+rus'), '--psm', '3']
          try {
            const r = await runProcessAsync('tesseract', args, { timeout: config.timeoutMs })
            result = (r.stdout || '').trim()
            usedEngine = 'tesseract'
          } finally {
            try { unlinkSync(tmpFile) } catch {}
          }
        } catch {}
      }

      if (!result) {
        // Fallback to vision LLM
        let prompt = 'Transcribe all visible text in this image in natural reading order.'
        if (format === 'markdown') prompt += ' Output as Markdown with proper headings, lists, and tables.'
        if (format === 'html') prompt += ' Output as clean HTML.'
        if (schema) {
          prompt += ` Reply with strict JSON matching this schema: ${JSON.stringify(schema)}. No commentary, just the JSON.`
        }
        prompt += ' Reply with the transcription only, no commentary.'
        const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, {})
        result = description || ''
        usedEngine = 'vision-llm'
      }

      return { text: result, engine: usedEngine, format: format || 'text' };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_long_ocr', description: 'Long screenshot OCR — Markdown transcription. Chunked/sliced when sharp is installed, single-pass otherwise.',
    parameters: { attachmentId: { type: 'string' }, chunkHeight: { type: 'number', description: 'chunk height px, default 1200 (used when slicing is available)' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { markdown: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.markdown}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    // #94: long-OCR bounds — 120s total budget, 40-chunk cap, cancellation
    // checks, stop on first backend failure.
    execute: async ({ attachmentId }, exec) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_long_ocr: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref);
      if (!src) throw new Error('vision_long_ocr: cannot read image');
      if (exec && exec.signal && exec.signal.aborted) throw new Error('vision_long_ocr: cancelled');
      const BUDGET_MS = 120000, CHUNK_CAP = 40
      // ponytail: no sharp dep — single-pass within budget. Upgrade: if sharp is
      // installed, slice the image into ≤CHUNK_CAP vertical bands of
      // `chunkHeight` px, OCR each with stop-on-first-backend-failure, stitch.
      const deadline = Date.now() + BUDGET_MS
      const remaining = deadline - Date.now()
      const { description } = await callVisionModelWithBytes(
        src.bytes, src.contentType,
        'This is a long screenshot. Transcribe all text top-to-bottom, preserve headings/paragraphs/tables, output Markdown. If content repeats across chunks, deduplicate.',
        { ...(exec ? { signal: exec.signal } : {}), chunkCap: CHUNK_CAP },
      )
      if (exec && exec.signal && exec.signal.aborted) throw new Error('vision_long_ocr: cancelled');
      return { markdown: description || '' };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_math_extract', description: 'Extract mathematical formulas from an image and return as LaTeX.',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { latex: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.latex}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_math_extract: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_math_extract: cannot read image');
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, 'Extract all mathematical formulas from this image. Convert each formula to LaTeX notation. Reply with the LaTeX code only, one formula per line. If multiple formulas, separate with blank lines.', {});
      return { latex: description || '' };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_ocr_local', description: 'Local OCR via Tesseract (no network). PSM modes: 3=screenshot,4=book,6=dense text,11=poster.',
    parameters: { attachmentId: { type: 'string' }, psm: { type: 'number', description: 'Tesseract PSM mode, default 3' }, lang: { type: 'string', description: 'e.g. eng+rus, default eng+rus' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, engine: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.text || v.engine}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, psm, lang }) => {
      if (!(await tesseractAvailable())) return { text: '', engine: 'tesseract not installed (apt install tesseract-ocr)' }
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_ocr_local: unknown ${attachmentId}`)
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_ocr_local: cannot read')
      const inFile = join(tmpdir(), `vbocr-${Date.now()}.png`)
      const outFile = inFile.replace(/\.png$/, '')
      writeFileSync(inFile, src.bytes)
      const args = [inFile, 'stdout', '-l', (lang || 'eng+rus'), '--psm', String(psm || 3)]
      try {
        const r = await runProcessAsync('tesseract', args, { timeout: config.timeoutMs })
        const text = (r.stdout || '').trim()
        return { text: text || (r.stderr?.split('\n')[0] || 'no text detected'), engine: `tesseract psm=${psm||3}` }
      } finally {
        try { unlinkSync(inFile) } catch {}
      }
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_describe_structured', description: 'Structured JSON analysis of image: summary, ocr, layout[], entities[], uncertainty[].',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.result}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }, exec) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_describe_structured: unknown ${attachmentId}`)
      const src = await resolveImageBytes(ref)
      if (!src) throw new Error('vision_describe_structured: cannot read image')
      const prompt = 'Analyze this image. Reply with strict JSON {"summary":string,"ocr":string,"layout":[{"region":string,"content":string}],"entities":[string],"uncertainty":[string]} where ocr is all visible text verbatim, layout lists spatial regions and contents, entities are named objects/brands/UI elements, uncertainty lists anything unclear.'
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) })
      let parsed = null; try { parsed = JSON.parse((description || '').match(/\{[\s\S]*\}/)?.[0] || '') } catch {}
      return { result: parsed ? JSON.stringify(parsed, null, 2) : (description || '') }
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_translate_image', description: 'Extract text from an image via OCR/vision and return it — ready for translation or further processing by the main model.',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.text}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_translate_image: unknown ${attachmentId}`)
      const src = await resolveImageBytes(ref)
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, 'Transcribe all text visible in this image exactly as written, preserving language and formatting. Output only the transcribed text.', {})
      return { text: description || '' }
    },
  }))

}
