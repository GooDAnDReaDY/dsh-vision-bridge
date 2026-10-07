import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLogger, setPluginLogger, getPluginLogger } from '../lib/logger.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const LIB_DIR = join(__dirname, '..', 'lib')

test('issue #366: host-side diagnostics route through logger, zero console.* in host domain modules', () => {
  const hostConsoleRegex = /\bconsole\.(log|warn|error|info|debug)\b/
  const offenders = []

  function scan(dir) {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        scan(full)
      } else if (entry.endsWith('.js') && entry !== 'client.js' && entry !== 'logger.js') {
        const text = readFileSync(full, 'utf8')
        const lines = text.split('\n')
        lines.forEach((line, idx) => {
          if (hostConsoleRegex.test(line)) {
            offenders.push(`${relative(LIB_DIR, full)}:${idx + 1}: ${line.trim()}`)
          }
        })
      }
    }
  }

  scan(LIB_DIR)
  assert.equal(offenders.length, 0, `Expected 0 host-side console.* calls in business logic, found: \n${offenders.join('\n')}`)
})

test('issue #366: getLogger and getPluginLogger lifecycle & contract', () => {
  // 1. Fallback when ctx is empty routes to fallback
  const fallback = getLogger(null)
  assert.equal(typeof fallback.debug, 'function')
  assert.equal(typeof fallback.info, 'function')
  assert.equal(typeof fallback.warn, 'function')
  assert.equal(typeof fallback.error, 'function')

  // 2. Custom mock ctx.logger function
  let capturedScope = null
  const logs = []
  const mockCtx = {
    logger: (scope) => {
      capturedScope = scope
      return {
        debug: (...args) => logs.push(['debug', ...args]),
        info: (...args) => logs.push(['info', ...args]),
        warn: (...args) => logs.push(['warn', ...args]),
        error: (...args) => logs.push(['error', ...args]),
      }
    },
  }

  const customLogger = getLogger(mockCtx, 'vision-bridge')
  assert.equal(capturedScope, 'vision-bridge')
  customLogger.warn('test warning')
  assert.deepEqual(logs, [['warn', 'test warning']])

  // 3. setPluginLogger sets global host logger
  setPluginLogger(customLogger)
  const pluginLogger = getPluginLogger()
  pluginLogger.debug('global debug')
  assert.deepEqual(logs, [['warn', 'test warning'], ['debug', 'global debug']])
  setPluginLogger(null)
})

