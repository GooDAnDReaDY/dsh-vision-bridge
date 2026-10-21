import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  apply,
  Config,
  SessionScopedAttachmentMap,
  extractSessionId,
  resolveInside,
} from '../lib/index.js'
import { _resetSharpCacheForTests } from '../lib/vision-core.js'
import {
  encodePng,
  decodePng,
  smartOptimizeImage,
} from '../lib/image-processing.js'
import { createMockCtx, setupWithAttachment, fakeReq, fakeRes } from './harness.js'
import { registerAnalysisTools } from '../lib/tools/analysis.js'
import { registerMediaTools } from '../lib/tools/media.js'

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' }
const image = encodePng(100, 100, Buffer.alloc(40000, 255))
const channel = {
  type: 'openai-compatible',
  baseURL: 'https://audit.invalid/v1',
  model: 'audit-model',
  apiKey: 'synthetic-only',
}
const answer = (s) => new Response(JSON.stringify({ choices: [{ message: { content: s } }] }), { status: 200 })

function tool(ctx, name, args = {}, exec) {
  return ctx.toolDefs.get(name).execute(args, exec)
}

async function route(ctx, url, method = 'GET', body) {
  const res = fakeRes()
  const key = url.startsWith('/dsh-vision-bridge/batch/') ? '/dsh-vision-bridge/batch' : url.split('?')[0]
  await ctx.routes.get(key).handler(fakeReq({ url, method, body: body === undefined ? '' : JSON.stringify(body), headers: SAME_ORIGIN }), res)
  return { status: res.status, body: JSON.parse(res.body) }
}

async function setup(config = {}) {
  globalThis.fetch = async () => answer('setup')
  const r = await setupWithAttachment({ imageBytes: image, config: { mode: 'hybrid', ...config } })
  await route(r.ctx, '/dsh-vision-bridge/cache', 'DELETE')
  r.ctx.streams.length = 0
  return r
}

function domain(register, overrides = {}) {
  const ctx = createMockCtx({ config: { consensusEnabled: true } })
  const d = {
    ctx,
    config: ctx.config,
    attachmentById: new SessionScopedAttachmentMap(),
    descriptionByAttachmentId: new Map(),
    descriptionByHash: new Map(),
    batches: new Map(),
    resolveImageBytes: async () => ({ bytes: image, contentType: 'image/png' }),
    resolveSourceBytes: async () => ({ bytes: image, contentType: 'image/png' }),
    callVisionModelWithBytes: async () => ({ description: 'NOT JSON', warnings: [] }),
    collectText: async () => '',
    visionSelection: async () => ({ provider: 'prov', model: 'm1' }),
    effectivePrompt: (x) => x,
    groundingPrompt: (x) => x,
    parseBbox: () => [0, 0, 1000, 1000],
    liveChannels: async () => [],
    extractSessionId,
    ...overrides,
  }
  d.attachmentById.set('A', { attachmentId: 'A', mediaType: 'image/png' })
  d.attachmentById.set('B', { attachmentId: 'B', mediaType: 'image/png' })
  register(d)
  return { ctx, d }
}

function makePngChunk(type, data) {
  const b = Buffer.alloc(12 + data.length)
  b.writeUInt32BE(data.length, 0)
  b.write(type, 4)
  data.copy(b, 8)
  b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)), 8 + data.length)
  return b
}

function make1x1Png(raw, interlace = 0) {
  const ih = Buffer.alloc(13)
  ih.writeUInt32BE(1, 0)
  ih.writeUInt32BE(1, 4)
  ih[8] = 8
  ih[9] = 6
  ih[12] = interlace
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makePngChunk('IHDR', ih),
    makePngChunk('IDAT', zlib.deflateSync(raw)),
    makePngChunk('IEND', Buffer.alloc(0)),
  ])
}

describe('Issue #429 Residual Audit Defect Fixes', () => {
  it('Config fields carry volatile metadata for settings persistence (#363, #374, #401)', () => {
    const nonVolatile = Object.entries(Config.dict)
      .filter(([, s]) => !s.meta?.volatile)
      .map(([k]) => k)
    assert.deepEqual(nonVolatile, [], 'All configurable fields must be volatile')
  })

  it('detail-low and detail-high do not share cache entries (#377)', async () => {
    const origFetch = globalThis.fetch
    try {
      const { ctx } = await setup({ channels: [channel] })
      let n = 0
      globalThis.fetch = async () => answer('answer-' + (++n))

      const a = await tool(ctx, 'vision_inspect', { source: 'att-1', prompt: 'same', detail: 'low' })
      const b = await tool(ctx, 'vision_inspect', { source: 'att-1', prompt: 'same', detail: 'high' })
      assert.equal(n, 2, 'Distinct detail parameter must produce separate channel calls')
      assert.equal(b.cached, false, 'detail: high must not hit detail: low cache')
      assert.notEqual(a.result, b.result)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('session isolation in vision_vqa and vision_annotate (#379)', async () => {
    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => answer('session-B answer')
      const ctx = createMockCtx({ imageBytes: image, config: { mode: 'tools', channels: [channel] } })
      apply(ctx, ctx.config)

      const ref = { attachmentId: 'session-B-only', mediaType: 'image/png' }
      const messages = [{ role: 'user', content: [{ type: 'image', attachment: ref }] }]
      await ctx.listeners.get('agent/pre-step')[0]({ agent: { id: 'B' }, messages }, async () => ({ messages }))

      let reads = []
      ctx.attachments.readImage = async (r) => {
        reads.push(r.attachmentId)
        return { data: image, ref: r }
      }

      await assert.rejects(
        () => tool(ctx, 'vision_vqa', { attachmentId: 'session-B-only', question: 'q' }, { agent: { id: 'A' } }),
        /unknown/
      )
      await assert.rejects(
        () => tool(ctx, 'vision_annotate', { attachmentId: 'session-B-only', annotations: [] }, { agent: { id: 'A' } }),
        /unknown/
      )
      assert.equal(reads.includes('session-B-only'), false, 'Session A must not read session B attachment')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('symlink target and ancestor containment checks throw (#369, #373, #376)', () => {
    const tmp = fs.mkdtempSync(path.join(path.resolve('test'), 'symlink-test-'))
    const root = path.join(tmp, 'root')
    const outside = path.join(tmp, 'outside')
    try {
      fs.mkdirSync(root, { recursive: true })
      fs.mkdirSync(outside, { recursive: true })
      fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'content')
      fs.symlinkSync(path.join(outside, 'sentinel.txt'), path.join(root, 'file-link'))
      fs.symlinkSync(outside, path.join(root, 'dir-link'))

      assert.throws(() => resolveInside(root, 'file-link'), /escapes directory \(symlink target\)/)
      assert.throws(() => resolveInside(root, 'dir-link/future.txt'), /escapes directory \(symlink ancestor\)/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('resolver does not fall back to local disk read on DSH fs denial (#380)', async () => {
    const tmp = fs.mkdtempSync(path.join(path.resolve('test'), 'dsh-denial-'))
    const filePath = path.join(tmp, 'read-denied.png')
    const origFetch = globalThis.fetch
    try {
      fs.writeFileSync(filePath, image)
      let denied = 0
      globalThis.fetch = async () => answer('{}')
      const ctx = createMockCtx({
        config: { mode: 'tools', allowedImageDirs: [tmp], channels: [channel] },
        fs: {
          resolve: async (p) => ({ path: p }),
          readBytes: async () => {
            denied++
            throw new Error('synthetic read denial')
          },
        },
      })
      apply(ctx, ctx.config)
      await assert.rejects(
        () => tool(ctx, 'vision_extract_formula', { path: filePath }),
        /image source not found/
      )
      assert.equal(denied, 1)
    } finally {
      globalThis.fetch = origFetch
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('PNG decoder rejects corrupt CRC, invalid filter, invalid interlace, and oversized scanline data (#383)', () => {
    const good = make1x1Png(Buffer.from([0, 1, 2, 3, 255]))
    const badCrc = Buffer.from(good)
    badCrc[29] ^= 1
    assert.throws(() => decodePng(badCrc), /CRC mismatch/)

    const badFilter = make1x1Png(Buffer.from([5, 1, 2, 3, 255]))
    assert.throws(() => decodePng(badFilter), /invalid PNG filter type/)

    const badInterlace = make1x1Png(Buffer.from([0, 1, 2, 3, 255]), 2)
    assert.throws(() => decodePng(badInterlace), /interlace method/)

    const excess = make1x1Png(Buffer.alloc(1024 * 1024))
    assert.throws(() => decodePng(excess), /excess scanline data/)
  })

  it('smartOptimizeImage truthful preprocessed and warning when sharp is unavailable (#384)', async () => {
    _resetSharpCacheForTests(null)
    const out = await smartOptimizeImage(new Uint8Array(image), 'image/png', { maxWidth: 10, maxHeight: 10 })
    assert.equal(decodePng(out.bytes).width, 100)
    assert.equal(out.preprocessed, false)
    assert.ok(out.warnings.some((w) => w.includes('sharp unavailable') || w.includes('downscaling skipped')))
  })

  it('vision_compare routes through callVisionModelWithBytes honoring channels (#387)', async () => {
    const origFetch = globalThis.fetch
    try {
      const { ctx } = await setup({ channels: [channel] })
      let calls = 0
      globalThis.fetch = async () => answer('channel-' + (++calls))

      await tool(ctx, 'describe_image', { attachmentIds: ['att-1'], question: 'describe-q' })
      await tool(ctx, 'vision_vqa', { attachmentId: 'att-1', question: 'vqa-q' })
      await tool(ctx, 'vision_compare', { attachmentIds: ['att-1', 'att-1'], question: 'compare-q' })

      assert.equal(calls, 3, 'describe_image, vision_vqa, and vision_compare must all invoke channels')
      assert.equal(ctx.streams.length, 0, 'No direct bypass to ctx.llm.stream')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('vision_audit_accessibility and vision_verify_generated_image strictly enforce boolean passed (#394)', async () => {
    const { ctx } = domain(registerAnalysisTools, {
      callVisionModelWithBytes: async () => ({ description: '{"score":90,"passed":"true","issues":[]}' }),
    })
    const outA11y = await tool(ctx, 'vision_audit_accessibility', { attachmentId: 'A' })
    assert.equal(outA11y.passed, false, 'String "true" must not be coerced to boolean true')
    assert.ok(outA11y.warnings.some((w) => w.includes('boolean')))

    const media = domain(registerMediaTools, {
      callVisionModelWithBytes: async () => ({ description: '{"score":95,"passed":"true","critique":"looks good","detectedElements":[]}' }),
    })
    const outGen = await tool(media.ctx, 'vision_verify_generated_image', { attachmentId: 'A' })
    assert.equal(outGen.passed, false, 'String "true" must not be coerced to boolean true in verify')
    assert.ok(outGen.warnings.some((w) => w.includes('boolean')))
  })
})
