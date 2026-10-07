import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment, fakeRes, fakeReq } from './harness.js'
import * as nodeFs from 'node:fs'
import {
  decodePng,
  encodePng,
  cropImageRegion,
  annotateImage,
  analyzeImageQuality,
  computePixelDiff,
} from '../lib/image-processing.js'

describe('expansion tools & deterministic engines (#303)', async () => {
  const { ctx } = await setupWithAttachment()
  const attachmentId = 'att-1'

  // Generate 10x10 synthetic RGBA PNG: top half red (255,0,0,255), bottom half green (0,255,0,255)
  const width = 10
  const height = 10
  const rawRgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      if (y < 5) {
        rawRgba[idx] = 255 // R
        rawRgba[idx + 1] = 0 // G
        rawRgba[idx + 2] = 0 // B
        rawRgba[idx + 3] = 255 // A
      } else {
        rawRgba[idx] = 0 // R
        rawRgba[idx + 1] = 255 // G
        rawRgba[idx + 2] = 0 // B
        rawRgba[idx + 3] = 255 // A
      }
    }
  }
  const testPng = encodePng(width, height, rawRgba)

  it('pure JS decodePng and encodePng perform lossless roundtrip', () => {
    const decoded = decodePng(testPng)
    assert.equal(decoded.width, 10)
    assert.equal(decoded.height, 10)
    assert.equal(decoded.rgba.length, 10 * 10 * 4)
    // Verify top-left pixel is red
    assert.equal(decoded.rgba[0], 255)
    assert.equal(decoded.rgba[1], 0)
    assert.equal(decoded.rgba[2], 0)
    // Verify bottom-left pixel is green
    assert.equal(decoded.rgba[5 * 10 * 4], 0)
    assert.equal(decoded.rgba[5 * 10 * 4 + 1], 255)

    // Re-encode and re-decode
    const reEncoded = encodePng(decoded.width, decoded.height, decoded.rgba)
    const reDecoded = decodePng(reEncoded)
    assert.equal(reDecoded.width, 10)
    assert.equal(reDecoded.height, 10)
    assert.deepEqual(reDecoded.rgba, decoded.rgba)
  })

  it('cropImageRegion extracts sub-rectangles with exact dimensions', async () => {
    const cropped = await cropImageRegion(testPng, { x: 0, y: 0, width: 5, height: 5 })
    assert.ok(Buffer.isBuffer(cropped.bytes))
    const decodedCrop = decodePng(cropped.bytes)
    assert.equal(decodedCrop.width, 5)
    assert.equal(decodedCrop.height, 5)
    // Top-left 5x5 should all be red
    assert.equal(decodedCrop.rgba[0], 255)
    assert.equal(decodedCrop.rgba[1], 0)
  })

  it('annotateImage draws bounding box outlines without throwing', async () => {
    const annotated = await annotateImage(testPng, [
      { bbox: [1, 1, 8, 8], color: 'yellow' }
    ], { thickness: 1 })
    assert.ok(Buffer.isBuffer(annotated.bytes))
    const decodedAnn = decodePng(annotated.bytes)
    assert.equal(decodedAnn.width, 10)
    assert.equal(decodedAnn.height, 10)
    // Check border pixel at (1, 1) was painted yellow (234, 179, 8)
    const pIdx = (1 * 10 + 1) * 4
    assert.equal(decodedAnn.rgba[pIdx], 234)
    assert.equal(decodedAnn.rgba[pIdx + 1], 179)
    assert.equal(decodedAnn.rgba[pIdx + 2], 8)
  })

  it('analyzeImageQuality computes brightness, contrast, blur score and dominant colors', async () => {
    const report = await analyzeImageQuality(testPng)
    assert.ok(typeof report.blurScore === 'number')
    assert.ok(typeof report.blurState === 'string')
    assert.ok(report.brightness >= 0 && report.brightness <= 100)
    assert.ok(report.contrast >= 0)
    assert.ok(Array.isArray(report.dominantPalette))
    assert.ok(report.dominantPalette.length > 0)
    assert.ok(typeof report.recommendation === 'string')
  })

  it('computePixelDiff detects differences and returns diff bounding box', async () => {
    // Diff testPng against itself -> 0% diff
    const sameDiff = await computePixelDiff(testPng, testPng)
    assert.equal(sameDiff.isIdentical, true)
    assert.equal(sameDiff.diffPercentage, 0)
    assert.deepEqual(sameDiff.changedBbox, [])

    // Modify 1 pixel
    const rawModified = Buffer.from(rawRgba)
    rawModified[0] = 0 // Change top-left red to black
    const modifiedPng = encodePng(width, height, rawModified)

    const diffReport = await computePixelDiff(testPng, modifiedPng)
    assert.equal(diffReport.isIdentical, false)
    assert.ok(diffReport.diffPercentage > 0)
    assert.ok(diffReport.changedBbox.length === 4)
    assert.equal(diffReport.changedBbox[0], 0)
    assert.equal(diffReport.changedBbox[1], 0)
  })

  it('vision_analyze_quality tool executes on attachmentId', async () => {
    const tool = ctx.toolDefs.get('vision_analyze_quality')
    assert.ok(tool, 'vision_analyze_quality must be registered')
    const res = await tool.execute({ attachmentId }, undefined)
    assert.ok(typeof res.blurScore === 'number')
    assert.ok(typeof res.recommendation === 'string')
  })

  it('vision_pixel_diff tool compares two attachments', async () => {
    const tool = ctx.toolDefs.get('vision_pixel_diff')
    assert.ok(tool, 'vision_pixel_diff must be registered')
    const res = await tool.execute({ attachmentIdA: attachmentId, attachmentIdB: attachmentId }, undefined)
    assert.equal(res.isIdentical, true)
    assert.equal(res.diffPercentage, 0)
  })

  it('vision_export_artifact exports table and diagram files', async () => {
    const tool = ctx.toolDefs.get('vision_export_artifact')
    assert.ok(tool, 'vision_export_artifact must be registered')

    const csvRes = await tool.execute({
      type: 'table',
      format: 'csv',
      filename: 'test-export-data.csv',
      content: 'col1,col2\nval1,val2',
    }, undefined)
    assert.equal(csvRes.success, true)
    assert.equal(csvRes.filename, 'test-export-data.csv')
    assert.ok(csvRes.bytesWritten > 0)
    if (nodeFs.existsSync(csvRes.path)) {
      nodeFs.unlinkSync(csvRes.path)
    }

    const mmdRes = await tool.execute({
      type: 'diagram',
      format: 'mermaid',
      filename: 'test-export-flow.mmd',
      content: 'graph TD; A-->B;',
    }, undefined)
    assert.equal(mmdRes.success, true)
    assert.equal(mmdRes.filename, 'test-export-flow.mmd')
    assert.ok(mmdRes.bytesWritten > 0)
    if (nodeFs.existsSync(mmdRes.path)) {
      nodeFs.unlinkSync(mmdRes.path)
    }
  })

  it('GET /dsh-vision-bridge/telemetry returns channel latency and metrics', async () => {
    const route = ctx.routes.get('/dsh-vision-bridge/telemetry')
    assert.ok(route, 'telemetry route must be registered')

    const req = fakeReq({ method: 'GET', url: '/dsh-vision-bridge/telemetry' })
    const res = fakeRes()
    await route.handler(req, res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.ok(Array.isArray(body.channels))
    assert.ok(typeof body.uptimeSeconds === 'number')
    assert.ok(Array.isArray(body.recentRequests))
  })
})
