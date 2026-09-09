// Executable security tests over apply() with the mock context.
//   #200 allowedImageDirs is enforced on the raw-fs fallback
//   #201 same-origin guards on bench/batch/journal/cache; doctor probes opt-in
//   #202 SSRF policy for server-side URL fetches (isSafeFetchUrl/isPrivateIp)
//   #211 apiKeyRef indirection + identity-based masked-key preservation
//   #209 canonical data-dsh-plugin ownership marker on the client style tag
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setupWithAttachment, createMockCtx, fakeRes, fakeReq } from './harness.js'

const clientSrc = () => readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

describe('#202 isPrivateIp — private/loopback/link-local ranges', async () => {
  const mod = await import('../lib/index.js')

  it('flags loopback, private, link-local, CGNAT and unspecified IPv4', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.16.0.9', '172.31.255.255', '169.254.169.254', '0.0.0.0', '100.64.0.1']) {
      assert.equal(mod.isPrivateIp(ip), true, ip)
    }
  })

  it('does not flag public IPv4 or garbage', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', 'not-an-ip', '']) {
      assert.equal(mod.isPrivateIp(ip), false, ip)
    }
  })

  it('flags IPv6 loopback, unique-local and link-local', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1']) {
      assert.equal(mod.isPrivateIp(ip), true, ip)
    }
    assert.equal(mod.isPrivateIp('2606:4700::1'), false)
  })
})

describe('#202 isSafeFetchUrl — fetch policy for model-supplied URLs', async () => {
  const mod = await import('../lib/index.js')
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
  const privateLookup = async () => [{ address: '10.0.0.9', family: 4 }]

  it('refuses non-http(s) schemes', async () => {
    assert.equal(await mod.isSafeFetchUrl('file:///etc/passwd'), false)
    assert.equal(await mod.isSafeFetchUrl('ftp://host/x'), false)
    assert.equal(await mod.isSafeFetchUrl('not a url'), false)
  })

  it('refuses literal private/loopback IPs without any DNS', async () => {
    assert.equal(await mod.isSafeFetchUrl('http://127.0.0.1:3080/x'), false)
    assert.equal(await mod.isSafeFetchUrl('http://192.168.1.1/x'), false)
    assert.equal(await mod.isSafeFetchUrl('http://169.254.169.254/latest/meta-data/'), false)
    assert.equal(await mod.isSafeFetchUrl('http://[::1]/x'), false)
  })

  it('refuses localhost names', async () => {
    assert.equal(await mod.isSafeFetchUrl('http://localhost/x'), false)
    assert.equal(await mod.isSafeFetchUrl('http://api.localhost/x'), false)
    assert.equal(await mod.isSafeFetchUrl('http://printer.local/x'), false)
  })

  it('resolves DNS and refuses hosts that land in private ranges', async () => {
    assert.equal(await mod.isSafeFetchUrl('http://internal.example/x', { lookup: privateLookup }), false)
    assert.equal(await mod.isSafeFetchUrl('http://cdn.example/x', { lookup: publicLookup }), true)
  })

  it('refuses hosts whose DNS resolution fails', async () => {
    assert.equal(await mod.isSafeFetchUrl('http://nx.example/x', { lookup: async () => { throw new Error('NXDOMAIN') } }), false)
  })

  it('allowlist mode: exact hostname match, no DNS', async () => {
    const opts = { allowedHosts: ['cdn.example'] }
    assert.equal(await mod.isSafeFetchUrl('http://cdn.example/x', opts), true)
    assert.equal(await mod.isSafeFetchUrl('http://other.example/x', opts), false)
  })
})

describe('#202/#200 tool-level boundaries over the mock ctx', async () => {
  it('describe_image refuses a loopback URL before any fetch', async () => {
    const { ctx } = await setupWithAttachment()
    const before = ctx.streams.length
    const tool = ctx.toolDefs.get('describe_image')
    await assert.rejects(
      () => tool.execute({ urls: ['http://127.0.0.1:9/x'], question: 'describe' }, undefined),
      /fetch policy/,
    )
    assert.equal(ctx.streams.length, before, 'no vision call may happen for a refused URL')
  })

  it('raw-fs fallback respects allowedImageDirs: outside dirs is refused (#200)', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: ['/definitely-not-allowed'] } })
    const tool = ctx.toolDefs.get('vision_extract_table')
    // /etc/hostname exists on the test host; without the fix it would be read.
    await assert.rejects(() => tool.execute({ path: '/etc/hostname' }, undefined), /not found/)
  })

  it('raw-fs fallback still works for paths inside allowedImageDirs (#200)', async () => {
    const { ctx } = await setupWithAttachment({ config: { allowedImageDirs: ['/etc'] } })
    const tool = ctx.toolDefs.get('vision_extract_table')
    const res = await tool.execute({ path: '/etc/hostname' }, undefined)
    assert.equal(res.table, 'MOCK DESCRIPTION')
  })
})

describe('#201 route guards', async () => {
  it('POST /bench is forbidden cross-site and allowed same-origin', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/bench').handler
    const denied = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }), denied)
    assert.equal(denied.status, 403)
    const ok = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }), ok)
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body).channels, [])
  })

  it('POST /batch (start and cancel) is forbidden cross-site', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/batch').handler
    const start = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{"attachmentIds":[]}' }), start)
    assert.equal(start.status, 403)
    const cancel = fakeRes()
    await handler(fakeReq({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, url: '/dsh-vision-bridge/batch/b1/cancel' }), cancel)
    assert.equal(cancel.status, 403)
  })

  it('DELETE /journal and DELETE /cache are forbidden cross-site, allowed same-origin', async () => {
    const { ctx } = await setupWithAttachment()
    for (const path of ['/dsh-vision-bridge/journal', '/dsh-vision-bridge/cache']) {
      const handler = ctx.routes.get(path).handler
      const denied = fakeRes()
      await handler(fakeReq({ method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } }), denied)
      assert.equal(denied.status, 403, path)
      const ok = fakeRes()
      await handler(fakeReq({ method: 'DELETE', headers: { 'sec-fetch-site': 'same-origin' } }), ok)
      assert.equal(ok.status, 200, path)
    }
  })

  it('GET /doctor is static by default and probes only with ?probe=1', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/doctor').handler
    const light = fakeRes()
    await handler(fakeReq({ method: 'GET', url: '/dsh-vision-bridge/doctor' }), light)
    assert.equal(light.status, 200)
    const lightBody = JSON.parse(light.body)
    assert.equal(lightBody.summary.probed, false)
    assert.equal(lightBody.summary.reachable, null)

    const probed = fakeRes()
    await handler(fakeReq({ method: 'GET', url: '/dsh-vision-bridge/doctor?probe=1' }), probed)
    assert.equal(probed.status, 200)
    const probedBody = JSON.parse(probed.body)
    assert.equal(probedBody.summary.probed, true)
    assert.equal(probedBody.summary.reachable, 0, 'zero configured channels: nothing reachable')
  })
})

describe('#211 apiKeyRef indirection', async () => {
  const mod = import('../lib/index.js')

  it('resolveChannelApiKey: explicit apiKey wins over apiKeyRef', async () => {
    const { resolveChannelApiKey } = await mod
    const ch = { type: 'openai-compatible', baseURL: 'http://x/v1', model: 'm', apiKey: 'explicit', apiKeyRef: 'IGNORED' }
    assert.equal((await resolveChannelApiKey(ch, async () => 'other')).apiKey, 'explicit')
  })

  it('resolveChannelApiKey: credential service resolves the referenced name', async () => {
    const { resolveChannelApiKey } = await mod
    const ch = { type: 'vllm', baseURL: 'http://x/v1', model: 'm', apiKeyRef: 'PROD_KEY' }
    const out = await resolveChannelApiKey(ch, async (n) => 'cred:' + n, {})
    assert.equal(out.apiKey, 'cred:PROD_KEY')
    assert.equal(ch.apiKey, undefined, 'input channel must stay untouched')
  })

  it('resolveChannelApiKey: env fallback when the credential service fails', async () => {
    const { resolveChannelApiKey } = await mod
    const ch = { type: 'vllm', baseURL: 'http://x/v1', model: 'm', apiKeyRef: 'MY_KEY' }
    const out = await resolveChannelApiKey(ch, async () => { throw new Error('no backend') }, { MY_KEY: 'env-value' })
    assert.equal(out.apiKey, 'env-value')
  })

  it('resolveChannelApiKey: unchanged when nothing resolves', async () => {
    const { resolveChannelApiKey } = await mod
    const ch = { type: 'vllm', baseURL: 'http://x/v1', model: 'm', apiKeyRef: 'MISSING' }
    assert.equal(await resolveChannelApiKey(ch, null, {}), ch)
    assert.equal(await resolveChannelApiKey(null), null)
  })

  it('masked keys are preserved per channel identity, not array position', async () => {
    const { ctx } = await setupWithAttachment({
      config: {
        channels: [
          { type: 'openai-compatible', baseURL: 'http://a/v1', model: 'm', apiKey: 'real-a' },
          { type: 'openai-compatible', baseURL: 'http://b/v1', model: 'm', apiKey: 'real-b' },
        ],
      },
    })
    const handler = ctx.routes.get('/dsh-vision-bridge/channels').handler
    // The card sends the list back reordered, keys masked for display.
    const reordered = [
      { type: 'openai-compatible', baseURL: 'http://b/v1', model: 'm', apiKey: 'zzzz...zzzz' },
      { type: 'openai-compatible', baseURL: 'http://a/v1', model: 'm', apiKey: 'zzzz...zzzz' },
    ]
    const res = fakeRes()
    await handler(fakeReq({
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ channels: reordered }),
    }), res)
    assert.equal(res.status, 200)
    assert.equal(ctx.config.channels[0].apiKey, 'real-b', 'b keeps its own key after reorder')
    assert.equal(ctx.config.channels[1].apiKey, 'real-a', 'a keeps its own key after reorder')
  })

  it('POST /channels rejects a non-string apiKeyRef', async () => {
    const { ctx } = await setupWithAttachment()
    const handler = ctx.routes.get('/dsh-vision-bridge/channels').handler
    const res = fakeRes()
    await handler(fakeReq({
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ channels: [{ type: 'openai-compatible', baseURL: 'http://c/v1', model: 'm', apiKeyRef: 123 }] }),
    }), res)
    assert.equal(res.status, 400)
    assert.ok(JSON.parse(res.body).error.includes('apiKeyRef'))
  })

  it('apiKeyRef itself is not a secret and survives GET /channels', async () => {
    const { ctx } = await setupWithAttachment({
      config: { channels: [{ type: 'vllm', baseURL: 'http://x/v1', model: 'm', apiKeyRef: 'PROD_KEY' }] },
    })
    const handler = ctx.routes.get('/dsh-vision-bridge/channels').handler
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    const body = JSON.parse(res.body)
    assert.equal(body.channels[0].apiKeyRef, 'PROD_KEY')
    assert.equal(body.channels[0].hasApiKey, undefined, 'no inline key to show')
  })
})

describe('#209 canonical style ownership marker', () => {
  it('client style tag sets data-dsh-plugin="dsh-vision-bridge"', () => {
    const src = clientSrc()
    assert.match(src, /tag\.dataset\.dshPlugin\s*=\s*['"]dsh-vision-bridge['"]/)
  })
})
