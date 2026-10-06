import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { isPathAllowed, resolveInside } from '../lib/vision-core.js'
import { registerDocumentTools } from '../lib/tools/document.js'

describe('Issue #373, #369, #376: Path Normalization & Directory Containment', () => {
  const allowedDir = resolve(tmpdir(), 'vbridge-allowed-test')
  if (!existsSync(allowedDir)) {
    mkdirSync(allowedDir, { recursive: true })
  }

  it('isPathAllowed rejects path traversal escaping allowedDirs (#373)', () => {
    const allowed = [allowedDir]

    // Legitimate paths inside allowed directory
    assert.equal(isPathAllowed(join(allowedDir, 'image.png'), allowed), true)
    assert.equal(isPathAllowed(join(allowedDir, 'sub', 'nested.png'), allowed), true)
    assert.equal(isPathAllowed(allowedDir, allowed), true)

    // Traversal attempts
    const traversal1 = join(allowedDir, '..', '..', 'etc', 'passwd')
    assert.equal(isPathAllowed(traversal1, allowed), false)

    const traversal2 = join(allowedDir, 'sub', '..', '..', 'outside.png')
    assert.equal(isPathAllowed(traversal2, allowed), false)

    // Sibling directory with shared prefix (e.g. /tmp/vbridge-allowed-test2)
    const sibling = allowedDir + '2'
    assert.equal(isPathAllowed(sibling, allowed), false)
  })

  it('resolveInside resolves valid subpaths and throws on escapes (#376)', () => {
    const base = allowedDir

    const validTarget = resolveInside(base, 'sub/data.csv')
    assert.equal(validTarget, resolve(base, 'sub/data.csv'))

    const validCurrent = resolveInside(base, '')
    assert.equal(validCurrent, resolve(base))

    // Escapes via relative ..
    assert.throws(() => {
      resolveInside(base, '../../outside.txt')
    }, /Path escapes directory/)

    // Escapes via absolute path outside base
    assert.throws(() => {
      resolveInside(base, '/etc/passwd')
    }, /Path escapes directory/)
  })

  it('vision_export_artifact blocks path traversal attacks (#369)', async () => {
    const registeredTools = new Map()
    const mockCtx = {
      tools: {
        register: (tool) => {
          registeredTools.set(tool.name, tool)
        },
      },
    }

    registerDocumentTools({
      ctx: mockCtx,
      config: { timeoutMs: 5000, allowedImageDirs: [allowedDir] },
    })

    const exportTool = registeredTools.get('vision_export_artifact')
    assert.ok(exportTool, 'vision_export_artifact should be registered')

    // Attempt traversal via ../../
    await assert.rejects(async () => {
      await exportTool.execute({
        content: 'malicious payload',
        filename: '../../../../tmp/evil.txt',
      })
    }, /vision_export_artifact: target path escapes directory/)

    // Attempt traversal via absolute path
    await assert.rejects(async () => {
      await exportTool.execute({
        content: 'malicious payload',
        filename: '/tmp/evil.txt',
      })
    }, /vision_export_artifact/)
  })
})
