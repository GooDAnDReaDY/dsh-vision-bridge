import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isNewerVersion, isTrustedUpdateRequest, getUpdateStatus, registerPluginUpdater } from '../lib/updater.js'

describe('plugin updater — semver comparisons (#309)', () => {
  it('detects newer patch and minor releases', () => {
    assert.strictEqual(isNewerVersion('0.5.37', '0.5.38'), true)
    assert.strictEqual(isNewerVersion('0.5.37', '0.6.0'), true)
    assert.strictEqual(isNewerVersion('0.5.37', '1.0.0'), true)
  })

  it('rejects identical or older versions', () => {
    assert.strictEqual(isNewerVersion('0.5.37', '0.5.37'), false)
    assert.strictEqual(isNewerVersion('0.5.37', '0.5.36'), false)
    assert.strictEqual(isNewerVersion('0.6.0', '0.5.37'), false)
  })

  it('correctly orders prereleases', () => {
    assert.strictEqual(isNewerVersion('0.6.0-rc.1', '0.6.0-rc.2'), true)
    assert.strictEqual(isNewerVersion('0.6.0-rc.2', '0.6.0'), true)
    assert.strictEqual(isNewerVersion('0.6.0', '0.6.0-rc.1'), false)
  })

  it('handles invalid semver gracefully', () => {
    assert.strictEqual(isNewerVersion('invalid', '0.6.0'), false)
    assert.strictEqual(isNewerVersion('0.6.0', 'invalid'), false)
  })
})

describe('plugin updater — security gate isTrustedUpdateRequest (#309)', () => {
  it('rejects request without update header', () => {
    const req = {
      headers: { host: 'localhost:3080', origin: 'http://localhost:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.strictEqual(isTrustedUpdateRequest(req), false)
  })

  it('rejects request from non-loopback ip', () => {
    const req = {
      headers: {
        'x-dsh-plugin-update': '1',
        host: '192.168.1.111:3080',
        origin: 'http://192.168.1.111:3080',
      },
      socket: { remoteAddress: '192.168.1.50' },
    }
    assert.strictEqual(isTrustedUpdateRequest(req), false)
  })

  it('rejects cross-site sec-fetch-site', () => {
    const req = {
      headers: {
        'x-dsh-plugin-update': '1',
        'sec-fetch-site': 'cross-site',
        host: 'localhost:3080',
        origin: 'http://localhost:3080',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.strictEqual(isTrustedUpdateRequest(req), false)
  })

  it('accepts valid loopback same-origin request with update header', () => {
    const req = {
      headers: {
        'x-dsh-plugin-update': '1',
        'sec-fetch-site': 'same-origin',
        host: 'localhost:3080',
        origin: 'http://localhost:3080',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.strictEqual(isTrustedUpdateRequest(req), true)
  })
})

describe('plugin updater — route integration (#309)', async () => {
  it('GET /api/dsh-vision-bridge/update returns current package status', async () => {
    let registeredHandler = null
    const mockCtx = {
      webServer: {
        register: ({ kind, path, handler }) => {
          if (path === '/api/dsh-vision-bridge/update') {
            registeredHandler = handler
          }
          return () => {}
        },
      },
    }

    registerPluginUpdater(mockCtx, {
      endpoint: '/api/dsh-vision-bridge/update',
      packageName: '@goodandready/dsh-vision-bridge',
      manifestUrl: new URL('../package.json', import.meta.url),
    })

    assert.ok(registeredHandler, 'updater route registered')

    let statusCode = 0
    let headers = {}
    let responseBody = ''
    const req = { method: 'GET' }
    const res = {
      writeHead: (code, h) => { statusCode = code; headers = h },
      end: (b) => { responseBody = b },
    }

    await registeredHandler(req, res)
    assert.strictEqual(statusCode, 200)
    const data = JSON.parse(responseBody)
    assert.strictEqual(data.packageName, '@goodandready/dsh-vision-bridge')
    assert.ok(typeof data.currentVersion === 'string')
  })

  it('POST /api/dsh-vision-bridge/update rejects untrusted requests with 403', async () => {
    let registeredHandler = null
    const mockCtx = {
      webServer: {
        register: ({ path, handler }) => {
          if (path === '/api/dsh-vision-bridge/update') registeredHandler = handler
          return () => {}
        },
      },
    }

    registerPluginUpdater(mockCtx, {
      endpoint: '/api/dsh-vision-bridge/update',
      packageName: '@goodandready/dsh-vision-bridge',
      manifestUrl: new URL('../package.json', import.meta.url),
    })

    let statusCode = 0
    let responseBody = ''
    const req = {
      method: 'POST',
      headers: { host: 'localhost:3080' },
      socket: { remoteAddress: '10.0.0.1' },
    }
    const res = {
      writeHead: (code) => { statusCode = code },
      end: (b) => { responseBody = b },
    }

    await registeredHandler(req, res)
    assert.strictEqual(statusCode, 403)
    const errData = JSON.parse(responseBody)
    assert.ok(errData.error.includes('Rejected'))
  })
})
