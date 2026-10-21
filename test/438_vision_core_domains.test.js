import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as core from '../lib/vision-core.js'
import * as configMod from '../lib/vision-config.js'
import * as securityMod from '../lib/security.js'
import * as providersMod from '../lib/providers.js'
import * as mediaMod from '../lib/media-utils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

test('Issue #438: vision-core domain decomposition', async (t) => {
  await t.test('domain modules export their expected symbols', () => {
    // 1. vision-config
    assert.ok(typeof configMod.name === 'string')
    assert.ok(Array.isArray(configMod.inject))
    assert.ok(typeof configMod.wrapConfig === 'function')
    assert.ok(typeof configMod.plainConfig === 'function')
    assert.ok(Boolean(configMod.Config))
    assert.ok(typeof configMod.sanitizeAllowed === 'function')
    assert.ok(typeof configMod.shouldBridgeForModel === 'function')
    assert.ok(typeof configMod.acceptsImages === 'function')
    assert.ok(typeof configMod.blocksHaveImage === 'function')

    // 2. security
    assert.ok(typeof securityMod.isLoopbackAddress === 'function')
    assert.ok(typeof securityMod.isTrustedSettingsRequest === 'function')
    assert.ok(typeof securityMod.maskApiKey === 'function')
    assert.ok(typeof securityMod.isMaskedKey === 'function')
    assert.ok(typeof securityMod.resolveInside === 'function')
    assert.ok(typeof securityMod.isPathAllowed === 'function')
    assert.ok(typeof securityMod.maskSecretsInError === 'function')
    assert.ok(typeof securityMod.isPrivateIp === 'function')
    assert.ok(typeof securityMod.isSafeFetchUrl === 'function')
    assert.ok(typeof securityMod.FETCH_POLICY_CODE === 'string')
    assert.ok(typeof securityMod.safeFetch === 'function')
    assert.ok(typeof securityMod.maskPII === 'function')
    assert.ok(typeof securityMod.maskSystemPaths === 'function')
    assert.ok(typeof securityMod.deriveKeyLabel === 'function')
    assert.ok(typeof securityMod.MAX_CONFIG_BODY_BYTES === 'number')
    assert.ok(typeof securityMod.MAX_BATCH_BODY_BYTES === 'number')
    assert.ok(typeof securityMod.readBoundedBody === 'function')

    // 3. providers
    assert.ok(Array.isArray(providersMod.FREE_VISION_PROVIDERS))
    assert.ok(typeof providersMod.resolveChannelApiKey === 'function')

    // 4. media-utils
    assert.ok(typeof mediaMod.bestEffort === 'function')
    assert.ok(typeof mediaMod.runLocalOCR === 'function')
    assert.ok(typeof mediaMod.rewriteImagesDeep === 'function')
    assert.ok(typeof mediaMod.VISION_PASS === 'symbol')
    assert.ok(typeof mediaMod.sniffMediaType === 'function')
    assert.ok(typeof mediaMod.loadSharp === 'function')
    assert.ok(typeof mediaMod._resetSharpCacheForTests === 'function')
    assert.ok(typeof mediaMod.compressImage === 'function')
    assert.ok(typeof mediaMod.stripEXIF === 'function')
    assert.ok(typeof mediaMod.deskewImage === 'function')
    assert.ok(typeof mediaMod.enhanceImage === 'function')
    assert.ok(typeof mediaMod.imageDimensions === 'function')
    assert.ok(typeof mediaMod.scaleBbox === 'function')
    assert.ok(typeof mediaMod.collectText === 'function')
    assert.ok(typeof mediaMod.contentHash === 'function')
    assert.ok(typeof mediaMod.bits64ToHex === 'function')
    assert.ok(typeof mediaMod.pHash === 'function')
    assert.ok(typeof mediaMod.checkImageQuality === 'function')
    assert.ok(typeof mediaMod.extractSessionId === 'function')
    assert.ok(typeof mediaMod.SessionScopedAttachmentMap === 'function')
  })

  await t.test('lib/vision-core.js facade re-exports 100% of symbols for backwards compatibility', () => {
    const allExpected = [
      ...Object.keys(configMod),
      ...Object.keys(securityMod),
      ...Object.keys(providersMod),
      ...Object.keys(mediaMod),
    ]

    for (const key of allExpected) {
      assert.ok(key in core, `Symbol ${key} must be re-exported by lib/vision-core.js`)
      assert.strictEqual(core[key], (configMod[key] || securityMod[key] || providersMod[key] || mediaMod[key]))
    }
  })

  await t.test('all domain modules and facade satisfy the <= 600 line limit', () => {
    const files = [
      'lib/vision-core.js',
      'lib/vision-config.js',
      'lib/security.js',
      'lib/providers.js',
      'lib/media-utils.js',
    ]

    for (const file of files) {
      const content = readFileSync(join(rootDir, file), 'utf8')
      const lineCount = content.split('\n').length
      assert.ok(
        lineCount <= 600,
        `${file} has ${lineCount} lines, exceeding the 600 line limit`
      )
    }
  })
})
