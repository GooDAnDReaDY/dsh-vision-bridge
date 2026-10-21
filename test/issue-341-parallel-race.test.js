import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { runChannels, channelKey } from '../lib/channels.js'

describe('Issue #341: parallel-race error resilience & loser cancellation', () => {
  it('fast 401 failure does not abort race if another channel succeeds', async () => {
    let fastCalled = false
    let slowCalled = false

    const serverFast = http.createServer((req, res) => {
      fastCalled = true
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid key' }))
    })

    const serverSlow = http.createServer((req, res) => {
      slowCalled = true
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ description: 'slow winner description' }))
        }
      }, 50)
    })

    try {
      await new Promise((r) => serverFast.listen(0, '127.0.0.1', r))
      await new Promise((r) => serverSlow.listen(0, '127.0.0.1', r))

      const portFast = serverFast.address().port
      const portSlow = serverSlow.address().port

      const channels = [
        { type: 'webhook', baseURL: `http://127.0.0.1:${portFast}`, model: 'fast-fail', apiKey: 'bad' },
        { type: 'webhook', baseURL: `http://127.0.0.1:${portSlow}`, model: 'slow-ok', apiKey: 'good' },
      ]

      const circuitStates = new Map()
      const cooldowns = new Map()

      const res = await runChannels(channels, {
        fallback: 'parallel-race',
        bytes: Buffer.from('test'),
        contentType: 'image/png',
        prompt: 'describe',
        timeoutMs: 5000,
        circuitStates,
        cooldowns,
      })

      assert.equal(res.ok, true, 'Race must succeed with the successful channel')
      assert.equal(res.description, 'slow winner description')
      assert.equal(res.channel.model, 'slow-ok')

      const fastKey = channelKey(channels[0])
      const slowKey = channelKey(channels[1])
      const fastCircuit = circuitStates.get(fastKey)
      const slowCircuit = circuitStates.get(slowKey)

      assert.ok(fastCircuit && fastCircuit.failures > 0, 'fast-fail must have recorded failure')
      assert.ok(slowCircuit && slowCircuit.state === 'closed', 'slow-ok must have circuit state closed')
    } finally {
      serverFast.close()
      serverSlow.close()
    }
  })

  it('aborts slower losers once winner resolves', async () => {
    let loserAborted = false

    const serverFast = http.createServer((req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ description: 'fast winner' }))
        }
      }, 20)
    })

    const serverSlow = http.createServer((req, res) => {
      req.on('aborted', () => { loserAborted = true })
      req.on('close', () => {
        if (req.destroyed) loserAborted = true
      })
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ description: 'slow' }))
        }
      }, 500)
    })

    try {
      await new Promise((r) => serverFast.listen(0, '127.0.0.1', r))
      await new Promise((r) => serverSlow.listen(0, '127.0.0.1', r))

      const portFast = serverFast.address().port
      const portSlow = serverSlow.address().port

      const channels = [
        { type: 'webhook', baseURL: `http://127.0.0.1:${portFast}`, model: 'fast', apiKey: 'k' },
        { type: 'webhook', baseURL: `http://127.0.0.1:${portSlow}`, model: 'slow', apiKey: 'k' },
      ]

      const res = await runChannels(channels, {
        fallback: 'parallel-race',
        bytes: Buffer.from('test'),
        contentType: 'image/png',
        prompt: 'describe',
        timeoutMs: 5000,
      })

      assert.equal(res.ok, true)
      assert.equal(res.description, 'fast winner')

      // Wait a brief moment for abort propagation
      await new Promise((r) => setTimeout(r, 60))

      assert.equal(loserAborted, true, 'Slower loser request must receive abort signal')
    } finally {
      serverFast.close()
      serverSlow.close()
    }
  })
})
