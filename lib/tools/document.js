// dsh-vision-bridge — tools: document domain (#206).
// Registrations moved verbatim from lib/index.js apply(); closure state
// arrives via the deps object `d`.

import { resolvedPathOf } from './attach.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runProcessAsync, isBinaryAvailable } from '../process.js'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function registerDocumentTools(d) {
const { ctx, config, attachmentById, descriptionByAttachmentId, descriptionByHash, batches, startBatch, callVisionModelWithBytes, visionSelection, resolveImageBytes, resolveSourceBytes, collectText, describeImage, effectivePrompt, liveChannels, groundingPrompt, parseBbox, tesseractAvailable } = d

ctx.tools.register(defineTool({
    name: 'vision_to_code', description: 'Generate code (HTML/CSS/React/Tailwind) from a UI screenshot.',
    parameters: { attachmentId: { type: 'string' }, framework: { type: 'string', description: "Target framework: 'html' (default), 'react', 'tailwind'" } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { code: { type: 'string' }, framework: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: v.code}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ attachmentId, framework }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_to_code: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_to_code: cannot read image');
      const fw = framework || 'html';
      const prompt = `Generate ${fw === 'react' ? 'React (JSX)' : fw === 'tailwind' ? 'Tailwind CSS HTML' : 'HTML with inline CSS'} code that recreates this UI screenshot. Include all visible elements (header, nav, buttons, cards, etc.). Use semantic HTML. Output ONLY the code, no explanation or markdown fences.`;
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, {});
      return { code: description || '', framework: fw };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_qr_read', description: 'Read QR codes and barcodes from an image. Returns decoded data.',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { codes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { type: { type: 'string' }, data: { type: 'string' } } } } } }, render(_a,v){ return [{type:'text',text: v.codes.length ? JSON.stringify(v.codes, null, 2) : 'no codes found'}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_qr_read: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_qr_read: cannot read image');
      // ponytail: use vision LLM to detect QR/barcode content. Upgrade: zxing/wasm for real decoding.
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, 'Look at this image. If it contains any QR codes or barcodes, decode them and reply with strict JSON {"codes":[{"type":"qr|barcode","data":"decoded_content"}]}. If no codes found, reply with {"codes":[]}.', {});
      let codes = [];
      try { const j = JSON.parse((description || '').match(/\{[\s\S]*\}/)?.[0] || ''); if (Array.isArray(j.codes)) codes = j.codes; } catch {}
      return { codes };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_pdf_pages', description: 'Extract PDF pages as images → describe each via vision LLM. Requires pdftoppm (poppler-utils).',
    parameters: { path: { type: 'string', description: 'local .pdf path' }, pages: { type: 'string', description: 'e.g. "1-5" or "1,3,7", default all' }, question: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { description: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.description}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 60000,
    execute: async ({ path, pages, question }) => {
      const fs = ctx.get('fs'); if (!fs) throw new Error('vision_pdf_pages: fs unavailable')
      const target = await fs.resolve(path); const pdfPath = resolvedPathOf(target, fs)
      const dir = tmpdir(); const stem = `vbpdf-${Date.now()}`
      const pageArgs = pages ? ['-f', String(pages.split('-')[0] || 1), '-l', String(pages.split('-')[1] || pages.split(',')[0] || 999)] : []
      const r = await runProcessAsync('pdftoppm', ['-png', '-r', '150', ...pageArgs, pdfPath, join(dir, stem)], { timeout: config.timeoutMs + 30000 })
      // pdftoppm outputs stem-1.png, stem-2.png … or stem-01.png etc.
      const frameRe = new RegExp('^' + stem + '-?\\d+\\.png$')
      const frames = existsSync(dir) ? readdirSync(dir).filter((f) => frameRe.test(f)).sort() : []
      if (frames.length === 0) return { description: `pdf_pages failed: no pages rendered (${r.stderr?.slice(0, 120)})` }
      const per = []
      for (const f of frames.sort()) {
        const bytes = readFileSync(join(dir, f)); try { unlinkSync(join(dir, f)) } catch {}
        const { description } = await callVisionModelWithBytes(bytes, 'image/png', question || `Describe this document page briefly.`, {})
        per.push(`--- ${f.replace(stem + '-', 'page ')} ---\n${description || ''}`)
      }
      return { description: per.join('\n\n') }
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_extract_formula',
    description: 'Extract mathematical equations, formulas, integrals, and matrices from an image into LaTeX/KaTeX format.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      format: { type: 'string', enum: ['latex', 'katex', 'asciimath'], default: 'latex', description: 'Output formula notation' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          latex: { type: 'string' },
          expressions: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: v.latex + (v.description ? '\n\n' + v.description : '') }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 20000,
    execute: async ({ attachmentId, path, format }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_extract_formula: image source not found');
      const prompt = 'Transcribe all mathematical formulas and equations in this image into clean ' + (format || 'latex') + '. '
        + 'Reply with strict JSON {"latex":"combined full LaTeX equations","expressions":["expr1","expr2"],"description":"brief explanation of the equations"}. '
        + 'Preserve sub/superscripts, fractions (\\frac), matrices, Greek letters, integrals, and summations accurately.';
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      return {
        latex: String(parsed?.latex || description || ''),
        expressions: Array.isArray(parsed?.expressions) ? parsed.expressions.map(String) : [],
        description: String(parsed?.description || ''),
      };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_extract_table',
    description: 'Extract complex tables, financial reports, spreadsheets from an image into Markdown, CSV, HTML, or JSON format.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      format: { type: 'string', enum: ['markdown', 'csv', 'html', 'json'], default: 'markdown', description: 'Desired output format' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: { type: 'string' },
          format: { type: 'string' },
          rowCount: { type: 'number' },
          colCount: { type: 'number' },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: v.table }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 20000,
    execute: async ({ attachmentId, path, format }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_extract_table: image source not found');
      const fmt = format || 'markdown';
      const prompt = 'Extract all tables from this image in ' + fmt.toUpperCase() + ' format. '
        + 'Reply with strict JSON {"table":"formatted table string in ' + fmt + '","rowCount":number,"colCount":number}. '
        + 'Preserve column alignment, headers, numbers, and merged cells accurately.';
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      return {
        table: String(parsed?.table || description || ''),
        format: fmt,
        rowCount: Number(parsed?.rowCount || 0),
        colCount: Number(parsed?.colCount || 0),
      };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_scan_barcode',
    description: 'Scan and decode QR codes, barcodes (EAN-13, UPC, Code-128, Code-39), and DataMatrix from an image without VLM token overhead.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      type: { type: 'string', enum: ['auto', 'qr', 'barcode', 'datamatrix'], default: 'auto', description: 'Type of code to look for' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean' },
          codes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string' },
                value: { type: 'string' },
                location: { type: 'string' },
              },
            },
          },
        },
      },
      render(_a, v) {
        return [{
          type: 'text',
          text: v.found
            ? (v.codes || []).map((c) => '[' + c.type + '] ' + c.value + ' (' + c.location + ')').join('\n')
            : 'No QR or barcodes detected in image.',
        }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, path, type }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_scan_barcode: image source not found');
      const prompt = 'Locate and decode any visible QR codes, barcodes (EAN-13, UPC, Code 128, Code 39, ITF), or DataMatrix in this image. '
        + 'Reply with strict JSON {"found":boolean,"codes":[{"type":"QR|EAN-13|Code-128|Barcode","value":"decoded payload string or URL","location":"top-right|bottom-center|etc"}]}. '
        + 'If none found, reply {"found":false,"codes":[]}.';
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      const codes = Array.isArray(parsed?.codes)
        ? parsed.codes.map((c) => ({
            type: String(c.type || 'QR'),
            value: String(c.value || ''),
            location: String(c.location || 'center'),
          }))
        : [];
      return {
        found: Boolean(parsed?.found ?? codes.length > 0),
        codes,
      };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_extract_structured',
    description: 'Extract structured fields from invoices, receipts, IDs, contracts, or forms according to a schema.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      schema: { type: 'string', description: 'JSON schema or list of fields to extract (e.g. "total, date, vendor, items")' },
      documentType: { type: 'string', enum: ['invoice', 'receipt', 'passport', 'id_card', 'contract', 'custom'], default: 'custom' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          data: { type: 'string' },
          confidence: { type: 'number' },
          missingFields: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: 'Confidence: ' + v.confidence + '%\n\n' + v.data }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 20000,
    execute: async ({ attachmentId, path, schema: schemaArg, documentType }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_extract_structured: image source not found');
      const doc = documentType || 'custom';
      const targetSchema = schemaArg || 'extract all key-value pairs, dates, amounts, and entities';
      const prompt = 'Extract structured data from this ' + doc + ' document. Target fields/schema: ' + targetSchema + '. '
        + 'Reply with strict JSON {"data":{...extracted key values...},"confidence":number(0-100),"missingFields":[string]}.';
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      return {
        data: parsed?.data ? JSON.stringify(parsed.data, null, 2) : String(description || '{}'),
        confidence: Number(parsed?.confidence ?? 90),
        missingFields: Array.isArray(parsed?.missingFields) ? parsed.missingFields.map(String) : [],
      };
    },
  }))

}
