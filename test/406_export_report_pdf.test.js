import test from 'node:test'
import assert from 'node:assert/strict'
import { registerMediaTools } from '../lib/tools/media.js'

test('issue #406: vision_export_report returns truthful markdown metadata', async () => {
  const registered = new Map()
  const mockCtx = {
    tools: { register(t) { registered.set(t.name, t) } },
    attachments: { saveImage: async () => ({ id: 'att-mock' }) },
  }
  registerMediaTools({
    ctx: mockCtx,
    config: { timeoutMs: 5000 },
    attachmentById: new Map(),
  })

  const exportTool = registered.get('vision_export_report')
  assert.ok(exportTool, 'vision_export_report registered')

  // Default format (markdown)
  const res = await exportTool.execute({
    title: 'Security Audit',
    results: [{ tool: 'vision_ocr', attachmentId: 'img-1', content: 'extracted text' }],
  })
  assert.equal(res.format, 'markdown')
  assert.equal(res.filename, 'report.md')
  assert.equal(res.mediaType, 'text/markdown')
  assert.ok(res.report.startsWith('# Security Audit'))
  assert.ok(res.report.includes('extracted text'))
})

test('issue #406: vision_export_report returns genuine PDF artifact when format=pdf', async () => {
  const registered = new Map()
  let savedAttachment = null
  const mockCtx = {
    tools: { register(t) { registered.set(t.name, t) } },
    attachments: {
      saveImage: async (payload) => {
        savedAttachment = payload
        return { id: 'pdf-att-123', attachmentId: 'pdf-att-123' }
      },
    },
  }
  registerMediaTools({
    ctx: mockCtx,
    config: { timeoutMs: 15000 },
    attachmentById: new Map(),
  })

  const exportTool = registered.get('vision_export_report')
  const res = await exportTool.execute({
    title: 'PDF Export Verification',
    results: [{ tool: 'vision_inspect', attachmentId: 'img-1', content: 'ui tree parsed' }],
    format: 'pdf',
  })

  assert.equal(res.format, 'pdf')
  assert.equal(res.filename, 'report.pdf')
  assert.equal(res.mediaType, 'application/pdf')
  assert.equal(res.attachmentId, 'pdf-att-123')

  // Verify decoded PDF content starts with magic %PDF-
  const buf = Buffer.from(res.report, 'base64')
  assert.ok(buf.length > 500, 'PDF buffer length must be non-trivial')
  assert.equal(buf.subarray(0, 4).toString('ascii'), '%PDF', 'Must contain valid %PDF magic bytes')

  // Verify saved attachment metadata
  assert.ok(savedAttachment)
  assert.equal(savedAttachment.mediaType, 'application/pdf')
  assert.equal(savedAttachment.name, 'report.pdf')
})

test('issue #406: vision_export_report rejects unsupported format', async () => {
  const registered = new Map()
  const mockCtx = {
    tools: { register(t) { registered.set(t.name, t) } },
  }
  registerMediaTools({
    ctx: mockCtx,
    config: { timeoutMs: 5000 },
    attachmentById: new Map(),
  })

  const exportTool = registered.get('vision_export_report')
  await assert.rejects(
    async () => {
      await exportTool.execute({ format: 'docx' })
    },
    (err) => {
      assert.ok(err.message.includes("unsupported format 'docx'"))
      return true
    }
  )
})
