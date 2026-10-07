// #246 review follow-up: the remote-attach path — declared length, real body
// size and the content-type/sniff decision. `readRemoteImage` takes the fetch
// implementation as a parameter, so every branch is reachable here with a stub
// and no network at all.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readRemoteImage } from '../lib/tools/attach.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const NOT_AN_IMAGE = Buffer.from('this is plain text, not an image')

const stubFetch = ({ body = PNG, contentType, contentLength, status = 200 } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (name) => {
      if (name.toLowerCase() === 'content-type') return contentType ?? null
      if (name.toLowerCase() === 'content-length') return contentLength ?? null
      return null
    },
  },
  arrayBuffer: async () => body,
})

describe('#246 remote attach validation', async () => {
  it('accepts an image content-type and reports it', async () => {
    const out = await readRemoteImage('https://example.com/a.png', {
      fetchImpl: stubFetch({ contentType: 'image/png', contentLength: String(PNG.length) }),
      maxBytes: 1024,
    })
    assert.equal(out.contentType, 'image/png')
    assert.deepEqual(out.bytes, PNG)
  })

  it('accepts a generic content-type when the bytes sniff as an image', async () => {
    const out = await readRemoteImage('https://example.com/a', {
      fetchImpl: stubFetch({ contentType: 'application/octet-stream' }),
      maxBytes: 1024,
    })
    assert.equal(out.contentType, 'application/octet-stream')
    assert.deepEqual(out.bytes, PNG)
  })

  it('falls back to the sniffed type when no content-type is sent', async () => {
    const out = await readRemoteImage('https://example.com/a', {
      fetchImpl: stubFetch({}),
      maxBytes: 1024,
    })
    assert.equal(out.contentType, 'image/png')
  })

  it('refuses a non-image content-type with non-image bytes', async () => {
    await assert.rejects(
      () => readRemoteImage('https://example.com/x', {
        fetchImpl: stubFetch({ body: NOT_AN_IMAGE, contentType: 'text/html' }),
        maxBytes: 1024,
      }),
      /is not an image \(content-type text\/html\)/,
    )
  })

  it('refuses a declared length above the limit before reading the body', async () => {
    let read = false
    const impl = async () => ({
      ok: true,
      status: 200,
      headers: { get: (n) => (n.toLowerCase() === 'content-length' ? '9999' : 'image/png') },
      arrayBuffer: async () => { read = true; return PNG },
    })
    await assert.rejects(
      () => readRemoteImage('https://example.com/big', { fetchImpl: impl, maxBytes: 100 }),
      /exceeds the 100 byte limit/,
    )
    assert.equal(read, false, 'the body must not be read once the declared length is over the limit')
  })

  it('refuses an undeclared body that is actually above the limit', async () => {
    await assert.rejects(
      () => readRemoteImage('https://example.com/big', {
        fetchImpl: stubFetch({ body: NOT_AN_IMAGE }),
        maxBytes: 8,
      }),
      /exceeds the 8 byte limit/,
    )
  })

  it('surfaces a non-2xx response as an error', async () => {
    await assert.rejects(
      () => readRemoteImage('https://example.com/missing', { fetchImpl: stubFetch({ status: 404 }), maxBytes: 1024 }),
      /GET https:\/\/example\.com\/missing -> 404/,
    )
  })
})
