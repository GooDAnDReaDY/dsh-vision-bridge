import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerAttachTools } from '../lib/tools/attach.js'
import { registerCoreTools } from '../lib/tools/core.js'

describe('Issue #340: Tool output strict schema & lossless-JSON compliance', () => {
  it('vision_attach_images outputSchema declares warnings and preserves lossless-JSON', async () => {
    const registered = []
    const ctx = {
      tools: {
        register: (tool) => { registered.push(tool) },
      },
      attachments: {
        saveImage: async ({ data, mediaType, name }) => ({ id: 'att-123', mediaType, name }),
      },
      get: (service) => {
        if (service === 'fs') {
          return {
            resolve: async (p) => p,
            readBytes: async () => Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'),
          }
        }
        return null
      },
    }
    const config = { timeoutMs: 30000, attachMaxItems: 8 }
    const attachmentById = new Map()
    const recordAttachment = (id, ref) => attachmentById.set(id, ref)

    registerAttachTools({ ctx, config, attachmentById, recordAttachment })
    const tool = registered.find((t) => t.name === 'vision_attach_images')
    assert.ok(tool, 'vision_attach_images should be registered')

    // 1. Verify schema declares warnings
    const schema = tool.output.schema
    assert.equal(schema.type, 'object')
    assert.equal(schema.additionalProperties, false)
    assert.ok(schema.properties.warnings, 'warnings property must be declared in schema')
    assert.equal(schema.properties.warnings.type, 'array')

    // 2. Execute with mock local file
    const { writeFileSync, unlinkSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const testFile = join(tmpdir(), 'vbr-test-340-' + Date.now() + '.png')
    const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex')
    writeFileSync(testFile, tinyPng)

    let res
    try {
      res = await tool.execute({ paths: [testFile] })
    } finally {
      try { unlinkSync(testFile) } catch {}
    }

    // 3. Verify returned keys match schema exactly (no undeclared properties)
    for (const key of Object.keys(res)) {
      assert.ok(schema.properties[key], `Returned property "${key}" must be declared in schema.properties`)
    }

    // 4. Verify lossless-JSON: no undefined fields dropped during serialization
    const serialized = JSON.stringify(res)
    const deserialized = JSON.parse(serialized)
    assert.deepEqual(deserialized, res, 'Output must be strictly lossless JSON')
    assert.ok(Array.isArray(res.warnings), 'warnings must be an array')
  })

  it('vision_inspect output returns strings for provider/model when channel is unset', async () => {
    const registered = []
    const ctx = {
      tools: {
        register: (tool) => { registered.push(tool) },
      },
      attachments: {
        readImage: async () => ({ data: Buffer.from('fake'), mediaType: 'image/png' }),
      },
      get: (service) => {
        if (service === 'fs') {
          return {
            resolve: async (p) => p,
            readBytes: async () => Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'),
          }
        }
        return null
      },
    }
    const config = { timeoutMs: 5000, maxImageBytes: 1000000 }
    const attachmentById = new Map()
    attachmentById.set('att-test', { attachmentId: 'att-test', mediaType: 'image/png' })

    const callVisionModelWithBytes = async () => ({
      description: 'A test image description',
      cached: false,
      warnings: [],
      // channel is undefined (no channel config)
    })

    registerCoreTools({
      ctx,
      config,
      attachmentById,
      callVisionModelWithBytes,
      describeImage: async () => ({ description: '' }),
    })

    const tool = registered.find((t) => t.name === 'vision_inspect')
    assert.ok(tool, 'vision_inspect should be registered')

    const res = await tool.execute({ source: 'att-test', mode: 'describe' })

    // Verify properties
    assert.equal(res.result, 'A test image description')
    assert.equal(typeof res.provider, 'string', 'provider must be a string, not undefined')
    assert.equal(typeof res.model, 'string', 'model must be a string, not undefined')
    assert.equal(res.provider, '')
    assert.equal(res.model, '')

    // Verify lossless-JSON
    const serialized = JSON.stringify(res)
    const deserialized = JSON.parse(serialized)
    assert.deepEqual(deserialized, res, 'vision_inspect output must be strictly lossless JSON')

    // Verify declared schema
    const schema = tool.output.schema
    for (const key of Object.keys(res)) {
      assert.ok(schema.properties[key], `Property "${key}" must be declared in output.schema`)
    }
  })
})
