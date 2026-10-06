import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerGroundingTools } from '../lib/tools/grounding.js'
import { SessionScopedAttachmentMap, extractSessionId } from '../lib/vision-core.js'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

describe('Issue #390 & #409: Vision Crop Numeric Region & Attachment Cap Enforcement', () => {
  it('Issue #390: numeric region does not invoke VLM and crops exact region', async () => {
    let vlmCalls = 0
    const registeredTools = new Map()
    const attachmentMap = new SessionScopedAttachmentMap()
    attachmentMap.set('att-1', { id: 'att-1', mediaType: 'image/png' })

    const mockCtx = {
      tools: { register: (t) => registeredTools.set(t.name, t) },
      attachments: {
        saveImage: async () => ({ id: 'saved-crop-id' }),
      },
    }

    registerGroundingTools({
      ctx: mockCtx,
      config: { timeoutMs: 5000 },
      attachmentById: attachmentMap,
      resolveImageBytes: async () => ({ bytes: TINY_PNG, contentType: 'image/png' }),
      callVisionModelWithBytes: async () => {
        vlmCalls++
        return { description: 'bbox [0, 0, 1000, 1000]' }
      },
      groundingPrompt: (q) => `locate: ${q}`,
      parseBbox: () => [0, 0, 1000, 1000],
      recordAttachment: (id, ref) => attachmentMap.set(id, ref),
      extractSessionId,
    })

    const cropTool = registeredTools.get('vision_crop')
    assert.ok(cropTool)

    // 1. String numeric region "0,0,500,500"
    vlmCalls = 0
    const resString = await cropTool.execute({
      attachmentId: 'att-1',
      region: '0,0,500,500',
    }, undefined)
    assert.ok(resString.attachmentId)
    assert.deepEqual(resString.bbox, [0, 0, 500, 500])
    assert.equal(vlmCalls, 0, 'Numeric string region must NOT call VLM')

    // 2. Bracketed numeric string "[100, 150, 400, 450]"
    vlmCalls = 0
    const resArrayStr = await cropTool.execute({
      attachmentId: 'att-1',
      region: '[100, 150, 400, 450]',
    }, undefined)
    assert.ok(resArrayStr.attachmentId)
    assert.deepEqual(resArrayStr.bbox, [100, 150, 400, 450])
    assert.equal(vlmCalls, 0, 'Numeric bracketed region must NOT call VLM')

    // 3. Invalid numeric coordinates "0,0,500" -> throws error
    await assert.rejects(
      async () => {
        await cropTool.execute({
          attachmentId: 'att-1',
          region: '0,0,500',
        }, undefined)
      },
      /invalid numeric region coordinates/,
    )

    // 4. Natural language query -> DOES call VLM
    vlmCalls = 0
    await cropTool.execute({
      attachmentId: 'att-1',
      target: 'blue submit button',
    }, undefined)
    assert.equal(vlmCalls, 1, 'Natural language target must call VLM grounding')
  })

  it('Issue #409: crop and annotate respect attachmentById cap of 300 via recordAttachment', async () => {
    const registeredTools = new Map()
    const attachmentMap = new SessionScopedAttachmentMap()
    attachmentMap.set('att-1', { id: 'att-1', mediaType: 'image/png' })

    const mockCtx = {
      tools: { register: (t) => registeredTools.set(t.name, t) },
      attachments: {
        saveImage: async () => ({ id: 'crop-save' }),
      },
    }

    const recordAttachment = (id, ref, sessionId = 'global') => {
      attachmentMap.set(String(id), ref, sessionId)
      while (attachmentMap.size > 300) {
        const oldest = attachmentMap.keys().next().value
        if (oldest !== undefined) attachmentMap.delete(oldest, sessionId)
        else break
      }
    }

    registerGroundingTools({
      ctx: mockCtx,
      config: { timeoutMs: 5000 },
      attachmentById: attachmentMap,
      resolveImageBytes: async () => ({ bytes: TINY_PNG, contentType: 'image/png' }),
      callVisionModelWithBytes: async () => ({ description: '' }),
      groundingPrompt: (q) => q,
      parseBbox: () => [0, 0, 1000, 1000],
      recordAttachment,
      extractSessionId,
    })

    const cropTool = registeredTools.get('vision_crop')
    const annotTool = registeredTools.get('vision_annotate')

    // Insert 320 items through crop and annotate
    for (let i = 0; i < 160; i++) {
      await cropTool.execute({
        attachmentId: 'att-1',
        region: '0, 0, 1000, 1000',
      }, undefined)
      await annotTool.execute({
        attachmentId: 'att-1',
        annotations: [{ bbox: [0, 0, 100, 100], label: 'test' }],
      }, undefined)
    }

    // Must never exceed cap of 300
    assert.ok(attachmentMap.size <= 300, `attachmentMap size ${attachmentMap.size} must be <= 300`)
  })
})
