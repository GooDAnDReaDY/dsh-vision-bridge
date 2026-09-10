// Executable tests for batch 3 (UX/docs honesty):
//   #203 dead settings: removed fakes (blurFaces/nsfwFilter/tile*), wired
//        real ones (maskPII, stripEXIF, auditLog, consensusEnabled)
//   #201 review follow-up: ?probe=1 requires same-origin
//   #210 host strings are English-sourced
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupWithAttachment, createMockCtx, fakeRes, fakeReq } from './harness.js'

const indexSrc = () => readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const clientSrc = () => readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

describe('#203 consensusEnabled gates the consensus tool', async () => {
  it('no vision_consensus by default (consensusEnabled=false)', async () => {
    const { ctx } = await setupWithAttachment()
    assert.equal(ctx.toolDefs.has('vision_consensus'), false)
  })

  it('vision_consensus registered when consensusEnabled=true', async () => {
    const { ctx } = await setupWithAttachment({ config: { consensusEnabled: true } })
    assert.equal(ctx.toolDefs.has('vision_consensus'), true)
  })
})

describe('#203 removed fake settings are gone from code and UI', () => {
  it('blurFaces / nsfwFilter / tileLargeImages / tileThreshold are fully removed', () => {
    for (const src of [indexSrc(), clientSrc()]) {
      for (const dead of ['blurFaces', 'nsfwFilter', 'tileLargeImages', 'tileThreshold', 'checkNSFW']) {
        assert.equal(src.includes(dead), false, dead + ' must be gone')
      }
    }
  })

  it('GET /config reflects consensusEnabled', async () => {
    const { ctx } = await setupWithAttachment({ config: { consensusEnabled: true } })
    const handler = ctx.routes.get('/dsh-vision-bridge/config').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    assert.equal(JSON.parse(res.body).consensusEnabled, true)
  })
})

describe('#203 maskPII masks the prompt actually sent to the vision model', async () => {
  it('generic describe_image questions are masked before the vision call', async () => {
    const { ctx } = await setupWithAttachment({ config: { maskPII: true } })
    const tool = ctx.toolDefs.get('describe_image')
    // 'what...picture' matches the generic regex -> callVisionModelWithBytes
    await tool.execute(
      { attachmentIds: ['att-1'], question: 'what contact info does the picture show for user@example.com' },
      undefined,
    )
    const sent = ctx.streams[ctx.streams.length - 1]
    const text = sent.messages[0].content[1].text
    assert.equal(text.includes('user@example.com'), false, 'PII must be masked')
  })

  it('truly non-generic questions are masked on the direct llm.stream path', async () => {
    const { ctx } = await setupWithAttachment({ config: { maskPII: true } })
    const tool = ctx.toolDefs.get('describe_image')
    // 'transcribe...' does NOT match the generic regex -> direct llm.stream
    await tool.execute(
      { attachmentIds: ['att-1'], question: 'transcribe the code block shown to user@example.com' },
      undefined,
    )
    const sent = ctx.streams[ctx.streams.length - 1]
    const text = sent.messages[0].content[1].text
    assert.equal(text.includes('user@example.com'), false, 'PII must be masked on the direct path too')
    assert.ok(text.includes('[EMAIL]'))
  })

  it('maskPII=false leaves the question untouched', async () => {
    const { ctx } = await setupWithAttachment()
    const tool = ctx.toolDefs.get('describe_image')
    await tool.execute(
      { attachmentIds: ['att-1'], question: 'transcribe the code block shown to user@example.com' },
      undefined,
    )
    const sent = ctx.streams[ctx.streams.length - 1]
    assert.ok(sent.messages[0].content[1].text.includes('user@example.com'))
  })
})

describe('#203 auditLog gates the journal', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const journalFile = (ctx) => join(ctx.config.evidenceDir, 'vision-journal.json')

  it("auditLog='off' (default) writes no journal file even after failed calls", async () => {
    const { ctx } = await setupWithAttachment({ config: { channels: [{ type: 'webhook' }] } })
    await sleep(1300)
    assert.equal(existsSync(journalFile(ctx)), false)
  })

  it("auditLog='all' records the journal entries", async () => {
    const { ctx } = await setupWithAttachment({ config: { auditLog: 'all', channels: [{ type: 'webhook' }] } })
    await sleep(1300)
    assert.equal(existsSync(journalFile(ctx)), true)
  })
})

describe('#201 review follow-up: ?probe=1 requires same-origin', async () => {
  it('cross-site probe request is forbidden, static report stays readable', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/doctor').handler
    const probed = fakeRes()
    await handler(fakeReq({ method: 'GET', url: '/dsh-vision-bridge/doctor?probe=1', headers: { 'sec-fetch-site': 'cross-site' } }), probed)
    assert.equal(probed.status, 403)
    const light = fakeRes()
    await handler(fakeReq({ method: 'GET', url: '/dsh-vision-bridge/doctor', headers: { 'sec-fetch-site': 'cross-site' } }), light)
    assert.equal(light.status, 200)
  })
})

describe('#210 source language: no hardcoded Russian user-facing strings', () => {
  it('tool default question and errors are English', () => {
    const src = indexSrc()
    assert.equal(src.includes('Опиши это изображение'), false)
    assert.equal(src.includes('Рекомендация'), false)
    assert.ok(src.includes("'Describe this image.'"))
  })

  it('client never passes a ready element into jsx() as its type (#226 review)', () => {
    const src = indexSrc() + clientSrc()
    assert.doesNotMatch(src, /jsx\s*\(\s*\(\(\)\s*=>/)
  })

  it('client has no bundled ru dictionary and no Russian toasts', () => {
    const src = clientSrc()
    assert.equal(src.includes('Конвертация'), false)
    assert.equal(src.includes('нажмите для переключения'), false)
    assert.match(src, /ctx\.locale\.register\(NS, \{ en \}\)/)
  })
})

describe('#222 settings card audit & safe lifecycle', () => {
  it('client.js wraps dictionary registration safely and avoids settings.section', () => {
    const src = clientSrc()
    // Safe locale registration with try/catch
    assert.match(src, /try\s*\{[\s\S]*locale.*register[\s\S]*\}\s*catch/)
    // settings.section must not be registered
    assert.equal(src.includes("'settings.section'"), false, 'settings.section slot must be removed')
    assert.ok(src.includes("'settings.plugin.item'"), 'settings.plugin.item card slot must be present')
  })

  it('client.js uses safe service access (ctx.get)', () => {
    const src = clientSrc()
    assert.ok(src.includes("ctx.get ? ctx.get('locale') : ctx.locale"), 'safe locale access')
    assert.ok(src.includes("ctx.get ? ctx.get('slots') : ctx.slots"), 'safe slots access')
  })

  it('POST /config supports expanded extraFields (cacheMaxEntries, channelFallback)', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/config').handler
    const res = fakeRes()
    await handler(
      fakeReq({
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({
          cacheMaxEntries: 512,
          channelFallback: 'parallel-race',
          nativePassthrough: 'never'
        })
      }),
      res
    )
    assert.equal(res.status, 200)
    const data = JSON.parse(res.body)
    assert.equal(data.cacheMaxEntries, 512)
    assert.equal(data.channelFallback, 'parallel-race')
    assert.equal(data.nativePassthrough, 'never')
  })
})
