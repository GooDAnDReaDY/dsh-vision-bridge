import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

describe('Issue #360: npm release package files allowlist', () => {
  it('pack output contains no skills/ files and no internal development documents', () => {
    const raw = execSync('npm pack --dry-run --json', { cwd: rootDir, encoding: 'utf8' })
    const startObj = raw.indexOf('{')
    const startArr = raw.indexOf('[')
    const isObj = startObj !== -1 && (startArr === -1 || startObj < startArr)
    const start = isObj ? startObj : startArr
    const endChar = isObj ? '}' : ']'
    const end = raw.lastIndexOf(endChar)
    assert.ok(start !== -1 && end > start, 'npm pack output must contain JSON object or array')
    const parsed = JSON.parse(raw.slice(start, end + 1))
    const packInfo = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
    assert.ok(packInfo && Array.isArray(packInfo.files), 'packInfo must have files array')
    const files = packInfo.files.map((f) => f.path)

    const skillFiles = files.filter((f) => f.startsWith('skills/'))
    assert.equal(skillFiles.length, 0, 'npm package must not ship unused skills/ files: ' + JSON.stringify(skillFiles))

    // Must not include internal dev docs or tests
    assert.equal(files.some((f) => f.startsWith('docs/')), false, 'docs/ must be excluded')
    assert.equal(files.some((f) => f.startsWith('test/')), false, 'test/ must be excluded')
    assert.equal(files.includes('AGENTS.md'), false, 'AGENTS.md must be excluded')

    // Must include required runtime artifacts and README trio
    assert.ok(files.includes('lib/index.js'), 'lib/index.js must be present')
    assert.ok(files.includes('lib/vision-core.js'), 'lib/vision-core.js must be present')
    assert.ok(files.includes('README.md'), 'canonical README.md must be present')
    assert.ok(files.includes('README.ru.md'), 'README.ru.md must be present')
    assert.ok(files.includes('README.zh.md'), 'README.zh.md must be present')
    assert.ok(files.includes('LICENSE'), 'LICENSE must be present')
    assert.ok(files.includes('cordis.patch.yml'), 'cordis.patch.yml must be present')
  })
})
