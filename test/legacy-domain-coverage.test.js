// test/legacy-domain-coverage.test.js — Comprehensive Coverage for Legacy Tool Domains (#292)
//
// Exercises execution pathways across legacy tool domains:
// - ocr.js
// - grounding.js
// - analysis.js
// - document.js
// - media.js

import { describe, it, after } from 'node:test'
import { unlinkSync, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'
import { setupWithAttachment, createMockCtx } from './harness.js'

describe('#292 Legacy Tool Domains Execution Coverage', async () => {
  after(() => {
    try {
      const files = readdirSync(process.cwd())
      for (const f of files) {
        if (f.startsWith('artifact-') && f.endsWith('.txt')) {
          unlinkSync(f)
        }
      }
    } catch (err) { /* bestEffort test cleanup */ void err }
  })
  const mockFs = {
    resolve: async (p) => ({ path: '/tmp/' + p }),
    writeBytes: async () => {},
  }

  const { ctx } = await setupWithAttachment({
    config: { timeoutMs: 10000 },
    streamText: '{"text": "Sample text", "bbox": [100, 200, 300, 400], "score": 0.95, "colors": ["#000000"]}',
    fs: mockFs,
  })

  describe('1. OCR domain (ocr.js)', () => {
    it('executes vision_ocr in text, markdown, html and schema modes', async () => {
      const tool = ctx.toolDefs.get('vision_ocr')
      assert.ok(tool)

      const rText = await tool.execute({ attachmentId: 'att-1', format: 'text' })
      assert.ok(rText && rText.text)

      const rMd = await tool.execute({ attachmentId: 'att-1', format: 'markdown' })
      assert.ok(rMd && rMd.text)

      const rHtml = await tool.execute({ attachmentId: 'att-1', format: 'html' })
      assert.ok(rHtml && rHtml.text)

      const rSchema = await tool.execute({ attachmentId: 'att-1', schema: { type: 'object' } })
      assert.ok(rSchema && rSchema.text)

      await assert.rejects(() => tool.execute({ attachmentId: 'bad-id' }), /unknown bad-id/)
    })

    it('executes vision_ocr_local', async () => {
      const tool = ctx.toolDefs.get('vision_ocr_local')
      assert.ok(tool)
      const res = await tool.execute({ attachmentId: 'att-1' })
      assert.ok(res)
    })

    it('executes vision_extract_structured', async () => {
      const tool = ctx.toolDefs.get('vision_extract_structured')
      assert.ok(tool)
      const res = await tool.execute({ attachmentId: 'att-1', schema: '{"type":"object"}' })
      assert.ok(res)
    })

    it('executes vision_extract_formula', async () => {
      const tool = ctx.toolDefs.get('vision_extract_formula')
      assert.ok(tool)
      const res = await tool.execute({ attachmentId: 'att-1' })
      assert.ok(res)
    })

    it('executes vision_extract_table in markdown and csv formats', async () => {
      const tool = ctx.toolDefs.get('vision_extract_table')
      assert.ok(tool)
      const r1 = await tool.execute({ attachmentId: 'att-1', format: 'markdown' })
      assert.ok(r1)
      const r2 = await tool.execute({ attachmentId: 'att-1', format: 'csv' })
      assert.ok(r2)
    })

    it('executes vision_long_ocr and vision_translate_image and vision_math_extract', async () => {
      const longTool = ctx.toolDefs.get('vision_long_ocr')
      assert.ok(longTool)
      await longTool.execute({ attachmentId: 'att-1' })

      const transTool = ctx.toolDefs.get('vision_translate_image')
      assert.ok(transTool)
      await transTool.execute({ attachmentId: 'att-1', targetLang: 'ru' })

      const mathTool = ctx.toolDefs.get('vision_math_extract')
      assert.ok(mathTool)
      await mathTool.execute({ attachmentId: 'att-1' })
    })
  })

  describe('2. Grounding domain (grounding.js)', () => {
    it('executes vision_ground and parses bbox', async () => {
      const tool = ctx.toolDefs.get('vision_ground')
      assert.ok(tool)
      const res = await tool.execute({ attachmentId: 'att-1', target: 'login button' })
      assert.ok(res && Array.isArray(res.bbox))
    })

    it('executes vision_detect', async () => {
      const tool = ctx.toolDefs.get('vision_detect')
      assert.ok(tool)
      const res = await tool.execute({ attachmentId: 'att-1', kind: 'buttons' })
      assert.ok(res)
    })

    it('executes vision_crop and vision_annotate', async () => {
      const crop = ctx.toolDefs.get('vision_crop')
      assert.ok(crop)
      const rCrop = await crop.execute({ attachmentId: 'att-1', region: '0,0,50,50' })
      assert.ok(rCrop && rCrop.attachmentId)

      const ann = ctx.toolDefs.get('vision_annotate')
      assert.ok(ann)
      const rAnn = await ann.execute({
        attachmentId: 'att-1',
        annotations: [{ bbox: [0, 0, 50, 50], label: 'Test' }],
      })
      assert.ok(rAnn && rAnn.attachmentId)
    })

    it('executes vision_extract_foreground and vision_trace', async () => {
      const fg = ctx.toolDefs.get('vision_extract_foreground')
      assert.ok(fg)
      await fg.execute({ attachmentId: 'att-1' })

      const trace = ctx.toolDefs.get('vision_trace')
      assert.ok(trace)
      await trace.execute({ attachmentId: 'att-1' })
    })
  })

  describe('3. Analysis domain (analysis.js)', () => {
    it('executes vision_diff and vision_compare', async () => {
      const diff = ctx.toolDefs.get('vision_diff')
      assert.ok(diff)
      const rDiff = await diff.execute({ attachmentIdA: 'att-1', attachmentIdB: 'att-1', focus: 'header' })
      assert.ok(rDiff && rDiff.summary)

      const comp = ctx.toolDefs.get('vision_compare')
      assert.ok(comp)
      const rComp = await comp.execute({ attachmentIds: ['att-1', 'att-1'] })
      assert.ok(rComp)
    })

    it('executes vision_colors, vision_analyze_quality, vision_quality_check', async () => {
      const col = ctx.toolDefs.get('vision_colors')
      assert.ok(col)
      await col.execute({ attachmentId: 'att-1' })

      const qual = ctx.toolDefs.get('vision_analyze_quality')
      assert.ok(qual)
      await qual.execute({ attachmentId: 'att-1' })

      const qc = ctx.toolDefs.get('vision_quality_check')
      assert.ok(qc)
      await qc.execute({ attachmentId: 'att-1' })
    })

    it('executes vision_audit_accessibility, vision_ui_layout, vision_ui_flow', async () => {
      const a11y = ctx.toolDefs.get('vision_audit_accessibility')
      assert.ok(a11y)
      await a11y.execute({ attachmentId: 'att-1' })

      const layout = ctx.toolDefs.get('vision_ui_layout')
      assert.ok(layout)
      await layout.execute({ attachmentId: 'att-1' })

      const flow = ctx.toolDefs.get('vision_ui_flow')
      assert.ok(flow)
      await flow.execute({ attachmentId: 'att-1' })
    })

    it('executes vision_pixel_diff, vision_describe_structured, vision_cot, vision_vqa', async () => {
      const pix = ctx.toolDefs.get('vision_pixel_diff')
      assert.ok(pix)
      await pix.execute({ attachmentIdA: 'att-1', attachmentIdB: 'att-1' })

      const desc = ctx.toolDefs.get('vision_describe_structured')
      assert.ok(desc)
      await desc.execute({ attachmentId: 'att-1' })

      const cot = ctx.toolDefs.get('vision_cot')
      assert.ok(cot)
      await cot.execute({ attachmentId: 'att-1', question: 'Analyze this UI' })

      const vqa = ctx.toolDefs.get('vision_vqa')
      assert.ok(vqa)
      await vqa.execute({ attachmentId: 'att-1', question: 'What is shown?' })
    })

    it('executes vision_verify_generated_image and vision_memory_search', async () => {
      const verify = ctx.toolDefs.get('vision_verify_generated_image')
      assert.ok(verify)
      await verify.execute({ attachmentId: 'att-1', prompt: 'a clean dashboard' })

      const mem = ctx.toolDefs.get('vision_memory_search')
      assert.ok(mem)
      await mem.execute({ query: 'login button UI' })
    })
  })

  describe('4. Document domain (document.js)', () => {
    it('executes vision_to_code with html, react, and tailwind frameworks', async () => {
      const tool = ctx.toolDefs.get('vision_to_code')
      assert.ok(tool)

      const rHtml = await tool.execute({ attachmentId: 'att-1', framework: 'html' })
      assert.ok(rHtml && rHtml.code)

      const rReact = await tool.execute({ attachmentId: 'att-1', framework: 'react' })
      assert.ok(rReact && rReact.code)

      const rTail = await tool.execute({ attachmentId: 'att-1', framework: 'tailwind' })
      assert.ok(rTail && rTail.code)
    })

    it('executes vision_export_artifact and vision_export_report', async () => {
      const art = ctx.toolDefs.get('vision_export_artifact')
      assert.ok(art)
      await art.execute({ attachmentId: 'att-1', title: 'Test Artifact', content: 'Sample artifact content' })

      const rep = ctx.toolDefs.get('vision_export_report')
      assert.ok(rep)
      await rep.execute({ attachmentId: 'att-1', title: 'Test Report', content: 'Sample report content' })
    })

    it('executes vision_page_persist', async () => {
      const persist = ctx.toolDefs.get('vision_page_persist')
      assert.ok(persist)
      await persist.execute({ attachmentId: 'att-1' })
    })
  })

  describe('5. Media domain (media.js)', () => {
    it('executes vision_qr_read and vision_scan_barcode', async () => {
      const qr = ctx.toolDefs.get('vision_qr_read')
      assert.ok(qr)
      await qr.execute({ attachmentId: 'att-1' })

      const bar = ctx.toolDefs.get('vision_scan_barcode')
      assert.ok(bar)
      await bar.execute({ attachmentId: 'att-1' })
    })

    it('executes vision_video_describe', async () => {
      const vid = ctx.toolDefs.get('vision_video_describe')
      assert.ok(vid)
      await vid.execute({ attachmentId: 'att-1' })
    })

    it('executes vision_materialize with mock fs', async () => {
      const written = new Map()
      const fsStub = {
        resolve: async (p) => ({ path: '/workspace/' + p }),
        writeBytes: async (target, bytes) => { written.set(target.path, bytes) },
      }
      const { ctx: customCtx } = await setupWithAttachment({ fs: fsStub })
      const tool = customCtx.toolDefs.get('vision_materialize')
      assert.ok(tool)

      const res = await tool.execute({ attachmentId: 'att-1', filename: 'image.png' })
      assert.ok(res && res.path)
      assert.equal(res.path, '/workspace/image.png')
    })
    it('executes vision_page_persist and vision_browser_snapshot policy rejection', async () => {
      const persist = ctx.toolDefs.get('vision_page_persist')
      assert.ok(persist)
      const rP = await persist.execute({ url: 'http://169.254.169.254/latest/meta-data/' })
      assert.ok(rP && rP.note && rP.note.includes('refused'))

      const snap = ctx.toolDefs.get('vision_browser_snapshot')
      assert.ok(snap)
      const rS = await snap.execute({ url: 'http://169.254.169.254/latest/meta-data/' })
      assert.ok(rS && rS.snapshot && rS.snapshot.includes('refused'))
    })

    it('executes vision_batch and vision_export_report', async () => {
      const batch = ctx.toolDefs.get('vision_batch')
      assert.ok(batch)
      const rBatch = await batch.execute({ attachmentIds: ['att-1'], prompt: 'describe' })
      assert.ok(rBatch && Array.isArray(rBatch.results))

      const report = ctx.toolDefs.get('vision_export_report')
      assert.ok(report)
      const rRep = await report.execute({
        title: 'Full Audit',
        attachmentIds: ['att-1'],
        results: [{ tool: 'vision_ocr', attachmentId: 'att-1', content: 'hello' }],
      })
      assert.ok(rRep && rRep.report)
    })
  })
})
