// #257: the attach paths the deterministic suites deliberately skipped — the
// real pdftoppm/ffmpeg executions and the publish() failure branches. The
// external binaries are exercised for real; when one is absent (e.g. ffmpeg is
// not part of the CI image) the case is skipped instead of pretending to pass.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupWithAttachment, testConfig } from './harness.js'
import { isBinaryAvailable } from '../lib/process.js'
import { resolvedPathOf, registerAttachTools } from '../lib/tools/attach.js'
import { FETCH_POLICY_CODE } from '../lib/vision-core.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

/**
 * Minimal but structurally valid PDF with real xref offsets, so poppler renders
 * it instead of running in repair mode. Without this the pages path could only
 * ever be tested against a broken document.
 */
function makePdf(pageTexts) {
  const n = pageTexts.length
  const fontNum = 3 + n * 2
  const kids = []
  const objects = [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${n} >>` },
  ]
  for (let i = 0; i < n; i++) {
    const pageNum = 3 + i * 2
    kids.push(pageNum)
    const stream = `BT /F1 24 Tf 40 100 Td (${pageTexts[i]}) Tj ET`
    objects.push({ num: pageNum, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${pageNum + 1} 0 R >>` })
    objects.push({ num: pageNum + 1, body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` })
  }
  objects.push({ num: fontNum, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' })
  objects.sort((a, b) => a.num - b.num)

  let out = '%PDF-1.4\n'
  const offset = {}
  for (const o of objects) {
    offset[o.num] = out.length
    out += `${o.num} 0 obj\n${o.body}\nendobj\n`
  }
  const xref = out.length
  const size = fontNum + 1
  out += `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let i = 1; i < size; i++) out += String(offset[i]).padStart(10, '0') + ' 00000 n \n'
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const run = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 60000 }, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })))
})

/**
 * Availability probe. The plugin's own isBinaryAvailable passes `--version`,
 * which poppler tools reject (they take `-v`) and ffmpeg rejects too
 * (`-version`), so it reports both as missing — probing here with the flag the
 * binary actually accepts keeps the skip from silently hiding these paths.
 */
const probe = async (bin, flag) => { try { await run(bin, [flag]); return true } catch { return false } }

let dir = ''
let pngA = ''
let pngB = ''
let pdf3 = ''

const hasPdftoppm = await probe('pdftoppm', '-v')
const hasFfmpeg = await probe('ffmpeg', '-version')

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'vbr-attach-exec-'))
  pngA = join(dir, 'a.png')
  pngB = join(dir, 'b.png')
  writeFileSync(pngA, PNG)
  writeFileSync(pngB, PNG)
  pdf3 = join(dir, 'three-pages.pdf')
  writeFileSync(pdf3, makePdf(['page one', 'page two', 'page three']))
})
after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

/** fs-service double returning the canonical { targetKey, displayPath }. */
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

const imagesTool = (ctx) => ctx.toolDefs.get('vision_attach_images')
const pagesTool = (ctx) => ctx.toolDefs.get('vision_attach_pages')
const framesTool = (ctx) => ctx.toolDefs.get('vision_attach_frames')

describe('#257 publish() failure branches', async () => {
  it('reports the saveImage error when nothing could be attached', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    ctx.attachments = { saveImage: async () => { throw new Error('store offline') } }
    await assert.rejects(
      () => imagesTool(ctx).execute({ paths: [pngA] }, undefined),
      /nothing to attach[\s\S]*store offline/,
    )
  })

  it('counts an attachment whose reference carries no id as failed', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    ctx.attachments = { saveImage: async () => ({ mediaType: 'image/png' }) }
    await assert.rejects(
      () => imagesTool(ctx).execute({ paths: [pngA] }, undefined),
      /nothing to attach/,
    )
  })

  it('keeps the good attachments and names the skipped one', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    let seq = 0
    ctx.attachments = {
      saveImage: async (o) => {
        if (o.name === 'a.png') throw new Error('rejected by store')
        return { attachmentId: 'att-' + (++seq) }
      },
    }
    const out = await imagesTool(ctx).execute({ paths: [pngA, pngB] }, undefined)
    assert.equal(out.items.length, 1)
    assert.match(out.note, /attached 1 image\(s\)/)
    assert.match(out.note, /Skipped 1: a\.png: rejected by store/)
  })

  it('reports a missing file as skipped instead of aborting the call', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    await assert.rejects(
      () => imagesTool(ctx).execute({ paths: [join(dir, 'missing.png')] }, undefined),
      /nothing to attach[\s\S]*missing\.png/,
    )
  })

  it('still attaches the readable sources when one path is broken (#258)', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    const out = await imagesTool(ctx).execute({ paths: [pngA, join(dir, 'gone.png')] }, undefined)
    assert.equal(out.items.length, 1, 'the readable path must still attach')
    assert.match(out.note, /Skipped 1: gone\.png/)
  })

  it('keeps a URL refused by the fetch policy a hard error, not a skip', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    await assert.rejects(
      () => imagesTool(ctx).execute({ paths: [pngA], urls: ['http://127.0.0.1/secret.png'] }, undefined),
      /URL refused by fetch policy/,
    )
  })

  it('refuses an explicit path outside allowedImageDirs', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    await assert.rejects(
      () => imagesTool(ctx).execute({ paths: [join(tmpdir(), 'outside.png')] }, undefined),
      /outside the allowedImageDirs/,
    )
  })
})

describe('#257 resolvedPathOf fallback', async () => {
  it('stringifies a target the fs service cannot map', () => {
    assert.equal(resolvedPathOf({ targetKey: 'opaque' }), '[object Object]')
    assert.equal(resolvedPathOf(undefined), '')
  })
})

// The URL branch only becomes deterministic with an injected fetch: the policy
// layer is bypassed by the host allowlist (no DNS), and the fetch itself is a
// stub, so these cases need no network at all.
describe('#257 URL sources through the injected fetch seam', async () => {
  const PNG_BYTES = PNG
  const stub = (status, contentType, body = PNG_BYTES) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => body,
  })

  function registerWith(fetchImpl) {
    const defs = new Map()
    let seq = 0
    const ctx = {
      tools: { register: (def) => defs.set(def.name, def) },
      attachments: { saveImage: async () => ({ attachmentId: 'att-' + (++seq) }) },
      get: (name) => (name === 'fs' ? fsStub() : undefined),
    }
    registerAttachTools({
      ctx,
      config: testConfig({ allowedImageDirs: [dir], allowedUrlHosts: ['example.com'] }),
      attachmentById: new Map(),
      recordAttachment: () => {},
      fetchImpl,
    })
    return defs
  }

  it('attaches an image fetched from an allowed host', async () => {
    const defs = registerWith(stub(200, 'image/png'))
    const out = await defs.get('vision_attach_images').execute({ urls: ['https://example.com/a.png'] }, undefined)
    assert.equal(out.items.length, 1)
    assert.match(out.note, /attached 1 image\(s\)/)
  })

  it('reports an unreachable URL as a skipped source instead of aborting', async () => {
    const defs = registerWith(stub(404, null))
    await assert.rejects(
      () => defs.get('vision_attach_images').execute({ urls: ['https://example.com/missing.png'] }, undefined),
      /nothing to attach[\s\S]*missing\.png[\s\S]*404/,
    )
  })

  it('still attaches the readable path when a sibling URL fails', async () => {
    const defs = registerWith(stub(500, null))
    const out = await defs.get('vision_attach_images').execute(
      { paths: [pngA], urls: ['https://example.com/broken.png'] },
      undefined,
    )
    assert.equal(out.items.length, 1)
    assert.match(out.note, /Skipped 1: broken\.png/)
  })

  it('re-throws a fetch-policy refusal arriving from a redirect hop', async () => {
    // safeFetch re-checks the policy on every hop; that error carries a code so
    // the tool cannot mistake it for a read failure and quietly skip the source.
    const defs = registerWith(async () => {
      throw Object.assign(new Error('URL refused by fetch policy (#202): http://127.0.0.1/x.png'), { code: FETCH_POLICY_CODE })
    })
    await assert.rejects(
      () => defs.get('vision_attach_images').execute({ urls: ['https://example.com/redirect.png'] }, undefined),
      /URL refused by fetch policy/,
    )
  })
})

describe('#257 vision_attach_pages executes pdftoppm', { skip: !hasPdftoppm && 'pdftoppm not installed' }, async () => {
  it('renders a real multi-page PDF and honours the per-call cap', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    const out = await pagesTool(ctx).execute({ path: pdf3, pages: '1-3', maxItems: 1 }, undefined)
    assert.equal(out.items.length, 1, 'cap of 1 must win over the requested range')
    assert.equal(out.truncated, true)
    assert.match(out.note, /attached 1 page image\(s\) \(cap 1, more pages available\)/)
    assert.match(out.items[0].id, /^att-/)
    assert.ok(out.items[0].bytes > 0)
  })

  it('renders every requested page within the cap', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    const out = await pagesTool(ctx).execute({ path: pdf3, pages: '2-3' }, undefined)
    assert.equal(out.items.length, 2)
    assert.equal(out.truncated, false)
    assert.deepEqual(out.items.map((i) => i.name), ['page-2.png', 'page-3.png'])
  })

  it('adds the document text layer (#259)', async (t) => {
    if (!(await isBinaryAvailable('pdftotext'))) return t.skip('pdftotext not installed')
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    const out = await pagesTool(ctx).execute({ path: pdf3, pages: '1' }, undefined)
    assert.ok(out.note.includes('Text layer:'), 'the layer must be reported, not silently dropped')
    assert.match(out.note, /page one/)
  })

  it('refuses a path outside allowedImageDirs before spawning anything', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    await assert.rejects(
      () => pagesTool(ctx).execute({ path: join(tmpdir(), 'elsewhere.pdf') }, undefined),
      /outside the allowedImageDirs/,
    )
  })

  it('reports a missing fs service', async () => {
    const { ctx } = await setupWithAttachment()
    await assert.rejects(() => pagesTool(ctx).execute({ path: pdf3 }, undefined), /fs service unavailable/)
  })

  it('surfaces an unreadable document instead of returning empty pages', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    const broken = join(dir, 'broken.pdf')
    writeFileSync(broken, '%PDF-1.4 broken')
    await assert.rejects(() => pagesTool(ctx).execute({ path: broken }, undefined), /no pages rendered/)
  })
})

describe('#257 vision_attach_frames executes ffmpeg', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  it('samples real frames from a generated video', async () => {
    const video = join(dir, 'clip.mp4')
    await run('ffmpeg', ['-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-pix_fmt', 'yuv420p', '-y', video])
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    const out = await framesTool(ctx).execute({ path: video, frames: 2 }, undefined)
    assert.ok(out.items.length >= 1, 'at least one frame must be attached')
    assert.match(out.note, /attached \d+ video frame\(s\) \(cap 2/)
    assert.equal(out.truncated, false)
    assert.match(out.items[0].id, /^att-/)
  })

  it('reports a request clamped by the hard cap (#260)', async () => {
    const video = join(dir, 'clip3.mp4')
    await run('ffmpeg', ['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-pix_fmt', 'yuv420p', '-y', video])
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    const out = await framesTool(ctx).execute({ path: video, frames: 40 }, undefined)
    assert.equal(out.truncated, true, 'asking for more frames than the cap must be reported')
    assert.match(out.note, /\(cap 32, more frames sampled\)/)
  })

  it('refuses a path outside allowedImageDirs', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    await assert.rejects(
      () => framesTool(ctx).execute({ path: join(tmpdir(), 'elsewhere.mp4') }, undefined),
      /outside the allowedImageDirs/,
    )
  })

  it('surfaces a non-video file instead of returning an empty result', async () => {
    const notVideo = join(dir, 'notes.txt')
    writeFileSync(notVideo, 'definitely not a video')
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: [dir] }, fs: fsStub() })
    await assert.rejects(() => framesTool(ctx).execute({ path: notVideo, frames: 1 }, undefined), /ffmpeg produced no frames/)
  })
})
