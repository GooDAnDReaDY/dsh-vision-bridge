// #345: eliminate multi-megabyte dataUrl roundtrip in /upload-pdf route
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment, fakeRes, fakeReq } from './harness.js'

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' }

const VALID_PDF = Buffer.from(
  '%PDF-1.4\n' +
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>\nendobj\n' +
  '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n' +
  '0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000201 00000 n \n' +
  'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n252\n%%EOF\n'
)

describe('POST /upload-pdf (#345 dataUrl elimination)', async () => {
  it('omits dataUrl from response by default to avoid huge Base64 payload', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/upload-pdf').handler
    const res = fakeRes()
    await handler(fakeReq({
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'content-type': 'application/pdf' },
      url: '/dsh-vision-bridge/upload-pdf',
      body: VALID_PDF,
    }), res)

    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.count, 1)
    assert.equal(body.pages.length, 1)
    const page = body.pages[0]
    assert.ok(page.attachmentId, 'attachmentId must be present')
    assert.ok(page.name.endsWith('-page-1.png'))
    assert.ok(page.bytes > 0)
    assert.equal(page.dataUrl, undefined, 'dataUrl must not be returned by default')
  })

  it('includes dataUrl only when explicitly requested via includeDataUrl=1', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/upload-pdf').handler
    const res = fakeRes()
    await handler(fakeReq({
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'content-type': 'application/pdf' },
      url: '/dsh-vision-bridge/upload-pdf?includeDataUrl=1',
      body: VALID_PDF,
    }), res)

    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.count, 1)
    assert.equal(body.pages.length, 1)
    const page = body.pages[0]
    assert.ok(page.dataUrl.startsWith('data:image/png;base64,'), 'dataUrl returned when requested')
  })
})
