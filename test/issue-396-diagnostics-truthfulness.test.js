import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerDiagnosticRoutes } from '../lib/routes/diagnostics.js'

describe('Issue #396: Diagnostic truthfulness in /dsh-vision-bridge/test route', () => {
  function createReq() {
    return {
      method: 'POST',
      headers: {
        'sec-fetch-site': 'same-origin',
        origin: 'http://localhost:3080',
        host: 'localhost:3080',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }
  }

  function createRes(cb) {
    return {
      status: 200,
      writeHead(st) { this.status = st },
      end(payload) { cb(this.status, JSON.parse(payload)) },
    }
  }

  it('reports ok: false when all channels fail with placeholder mode', async () => {
    let capturedOpts = null
    const callVisionModelWithBytes = async (_bytes, _type, _prompt, opts) => {
      capturedOpts = opts
      return {
        ok: false,
        error: 'all channels failed (500 internal server error)',
        description: '[image description unavailable: all channels failed]',
      }
    }

    let routeHandler = null
    const ctx = {
      effect: (fn) => fn(),
      webServer: {
        register: (def) => {
          if (def.path === '/dsh-vision-bridge/test') routeHandler = def.handler
        },
      },
    }

    registerDiagnosticRoutes(ctx, { callVisionModelWithBytes, config: {} })
    assert.ok(routeHandler, 'POST /dsh-vision-bridge/test handler must be registered')

    let statusCode = null
    let responseBody = null
    await routeHandler(createReq(), createRes((st, body) => {
      statusCode = st
      responseBody = body
    }))

    assert.equal(statusCode, 200)
    assert.equal(responseBody.ok, false, 'Failed probe must report ok: false')
    assert.ok(responseBody.error, 'Error message must be populated')
    assert.ok(responseBody.error.includes('all channels failed'))
    assert.equal(capturedOpts?.noCache, true, 'Probe must pass noCache: true')
  })

  it('reports ok: true when vision call succeeds', async () => {
    const callVisionModelWithBytes = async () => ({
      ok: true,
      description: 'OK',
    })

    let routeHandler = null
    const ctx = {
      effect: (fn) => fn(),
      webServer: {
        register: (def) => {
          if (def.path === '/dsh-vision-bridge/test') routeHandler = def.handler
        },
      },
    }

    registerDiagnosticRoutes(ctx, { callVisionModelWithBytes, config: {} })

    let responseBody = null
    await routeHandler(createReq(), createRes((_st, body) => {
      responseBody = body
    }))

    assert.equal(responseBody.ok, true)
    assert.equal(responseBody.text, 'OK')
  })
})
