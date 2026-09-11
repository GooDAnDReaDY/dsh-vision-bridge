// #246 review: the central attach path — resolution, publishing, image blocks
// and limits — exercised deterministically with an injected fs service and
// real temporary image files (no pdftoppm/ffmpeg involved).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupWithAttachment } from './harness.js'
import { resolvedPathOf } from '../lib/tools/attach.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

let dir = ''
let fileA = ''
let fileB = ''
let fileC = ''

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'vbr-attach-'))
  fileA = join(dir, 'a.png')
  fileB = join(dir, 'b.png')
  fileC = join(dir, 'c.png')
  for (const f of [fileA, fileB, fileC]) writeFileSync(f, PNG)
})
after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

/** fs-service double: resolve() returns the canonical { targetKey, displayPath }. */
function fsStub() {
  return {
    resolve: async (p) => ({ targetKey: 'key:' + p, displayPath: p }),
    readBytes: async (target, _opts, max) => {
      const bytes = readFileSync(target.displayPath)
      if (max && bytes.length > max) throw new Error('readBytes: exceeds limit')
      return bytes
    },
  }
}

const attachTool = (ctx) => ctx.toolDefs.get('vision_attach_images')

describe('#246 attach publish path', async () => {
  it('resolvedPathOf prefers the process path over displayPath', () => {
    assert.equal(resolvedPathOf({ targetKey: 'k', displayPath: '/tmp/x.pdf' }), '/tmp/x.pdf')
    assert.equal(resolvedPathOf('/plain/path'), '/plain/path')
    // fs.processPath is the canonical path a subprocess can open; displayPath is
    // display-only and may differ in a sandboxed/remote execution world.
    assert.equal(resolvedPathOf({ displayPath: '/d' }, { processPath: () => '/from-process' }), '/from-process')
    assert.equal(resolvedPathOf({ displayPath: '/d', path: '/explicit' }, { processPath: () => '/from-process' }), '/explicit')
    // a throwing processPath must fall back to displayPath
    assert.equal(resolvedPathOf({ displayPath: '/d' }, { processPath: () => { throw new Error('nope') } }), '/d')
    assert.equal(resolvedPathOf({ targetKey: 'k' }, { processPath: () => '/from-process' }), '/from-process')
    assert.equal(resolvedPathOf(null), '')
  })

  it('publishes local files and renders image blocks with valid refs', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    const value = await attachTool(ctx).execute({ paths: [fileA, fileB] }, undefined)
    assert.equal(value.items.length, 2)
    assert.equal(value.truncated, false)
    const blocks = attachTool(ctx).output.render({}, value)
    const images = blocks.filter((b) => b.type === 'image')
    assert.equal(images.length, 2, 'each published image becomes an image block')
    for (const block of images) assert.ok(block.attachment, 'the block must carry an attachment ref')
    const note = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    assert.match(note, /attached 2 image\(s\)/)
  })

  it('honours attachMaxItems and reports truncation', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir], attachMaxItems: 2 }, fs: fsStub() })
    const value = await attachTool(ctx).execute({ paths: [fileA, fileB, fileC] }, undefined)
    assert.equal(value.items.length, 2)
    assert.equal(value.truncated, true)
    assert.match(value.note, /more sources available/)
  })

  it('scans a directory through the fs service', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    const value = await attachTool(ctx).execute({ dirs: [dir] }, undefined)
    assert.equal(value.items.length, 3)
  })

  it('refuses a path outside allowedImageDirs', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: ['/definitely-not-allowed'] }, fs: fsStub() })
    await assert.rejects(() => attachTool(ctx).execute({ paths: [fileA] }, undefined), /outside the allowedImageDirs/)
  })

  it('surfaces a read failure for an explicitly requested file', async () => {
    // an explicit path is a direct request: a read failure is reported, not skipped
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir], maxImageBytes: 10 }, fs: fsStub() })
    await assert.rejects(() => attachTool(ctx).execute({ paths: [fileA] }, undefined), /exceeds limit/)
  })
})
