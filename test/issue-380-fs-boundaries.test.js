import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerGroundingTools } from '../lib/tools/grounding.js'
import { registerMediaTools } from '../lib/tools/media.js'

describe('Issue #380 & #381: FS Boundaries and Permissions', () => {
  it('vision_present throws when path is outside allowedImageDirs (#380)', async () => {
    const registeredTools = new Map()
    const mockCtx = {
      tools: {
        register: (tool) => registeredTools.set(tool.name, tool),
      },
      get: (service) => {
        if (service === 'fs') {
          return {
            resolve: async (p) => ({ path: '/workspace/' + p }),
            readBytes: async () => Buffer.from('fake-bytes'),
          }
        }
        return null
      },
      attachments: {
        saveImage: async () => ({ attachmentId: 'att-123' }),
      },
    }

    registerGroundingTools({
      ctx: mockCtx,
      config: { timeoutMs: 5000, allowedImageDirs: ['/workspace/allowed'] },
      attachmentById: new Map(),
    })

    const tool = registeredTools.get('vision_present')
    assert.ok(tool)

    await assert.rejects(async () => {
      await tool.execute({ path: '/etc/shadow' })
    }, /vision_present: path outside allowedImageDirs/)
  })

  it('vision_materialize does not bypass fs.writeBytes failure with node:fs (#381)', async () => {
    const registeredTools = new Map()
    const mockCtx = {
      tools: {
        register: (tool) => registeredTools.set(tool.name, tool),
      },
      get: (service) => {
        if (service === 'fs') {
          return {
            resolve: async (name) => ({ path: '/protected/' + name }),
            writeBytes: async () => {
              throw new Error('EACCES: permission denied by workspace policy')
            },
          }
        }
        return null
      },
    }

    const attachmentMap = new Map([
      ['att-secret', { attachmentId: 'att-secret', mediaType: 'image/png' }],
    ])

    registerMediaTools({
      ctx: mockCtx,
      config: { timeoutMs: 5000 },
      attachmentById: attachmentMap,
      resolveImageBytes: async () => ({ bytes: Buffer.from('img-bytes'), contentType: 'image/png' }),
    })

    const tool = registeredTools.get('vision_materialize')
    assert.ok(tool)

    await assert.rejects(async () => {
      await tool.execute({ attachmentId: 'att-secret', filename: 'target.png' })
    }, /EACCES: permission denied by workspace policy/)
  })
})
