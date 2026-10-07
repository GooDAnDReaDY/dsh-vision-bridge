import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerMediaTools, captureHtmlScreenshot } from '../lib/tools/media.js'

function getPngDimensions(buf) {
  assert.ok(buf.length >= 24, 'PNG buffer must have at least 24 bytes')
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Must start with PNG magic bytes')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return { width, height }
}

test('issue #407: long HTML fixture verifies fullPage vs viewport screenshots', async () => {
  // Create a long HTML document fixture (> 2400px tall)
  const fixturePath = join(tmpdir(), `fixture-long-${Date.now()}.html`)
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
<style>
body { margin: 0; padding: 0; font-family: sans-serif; }
.section { height: 800px; background: #e0f2fe; border-bottom: 2px solid #0284c7; padding: 20px; }
.footer { height: 200px; background: #0369a1; color: white; padding: 20px; }
</style>
</head>
<body>
<div class="section"><h1>Section 1</h1></div>
<div class="section"><h1>Section 2</h1></div>
<div class="section"><h1>Section 3</h1></div>
<div class="footer"><h1>Footer Bottom (at ~2600px)</h1></div>
</body>
</html>`
  writeFileSync(fixturePath, htmlContent, 'utf8')

  try {
    // 1. Viewport screenshot (fullPage: false) -> clamped to viewport height 1024
    const viewportBytes = await captureHtmlScreenshot({
      htmlPath: fixturePath,
      width: 1280,
      fullPage: false,
    })
    const viewportDims = getPngDimensions(viewportBytes)
    assert.equal(viewportDims.width, 1280, 'Viewport width must be 1280')
    assert.equal(viewportDims.height, 1024, 'Viewport height must be exactly 1024')

    // 2. Full page screenshot (fullPage: true) -> captures beyond viewport height (> 2000px)
    const fullPageBytes = await captureHtmlScreenshot({
      htmlPath: fixturePath,
      width: 1280,
      fullPage: true,
    })
    const fullPageDims = getPngDimensions(fullPageBytes)
    assert.equal(fullPageDims.width, 1280, 'Full page width must be 1280')
    assert.ok(fullPageDims.height >= 2400, `Full page height must capture entire document (got ${fullPageDims.height})`)

    // 3. Verify tool execution via vision_html_screenshot
    const savedImages = []
    const mockCtx = {
      tools: { register() {} },
      get(svc) {
        if (svc === 'fs') {
          return {
            async resolve(p) { return { path: p } },
          }
        }
        return null
      },
      attachments: {
        async saveImage(img) {
          savedImages.push(img)
          return { id: 'att-shot-' + savedImages.length }
        },
      },
    }

    const registered = new Map()
    registerMediaTools({
      ctx: {
        ...mockCtx,
        tools: { register(t) { registered.set(t.name, t) } },
      },
      config: { timeoutMs: 15000 },
      attachmentById: new Map(),
    })

    const tool = registered.get('vision_html_screenshot')
    assert.ok(tool, 'vision_html_screenshot registered')

    // Execute with fullPage: true
    const toolRes = await tool.execute({ path: fixturePath, width: 1280, fullPage: true })
    assert.equal(toolRes.note, 'screenshot rendered')
    assert.ok(toolRes.attachmentId)
    assert.equal(savedImages.length, 1)
    const toolSavedDims = getPngDimensions(savedImages[0].data)
    assert.ok(toolSavedDims.height >= 2400, `Tool fullPage must produce tall screenshot (got ${toolSavedDims.height})`)
  } finally {
    try { unlinkSync(fixturePath) } catch {}
  }
})
