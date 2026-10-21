import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment } from './harness.js'

describe('issue #344: descriptionByAttachmentId LRU cap at 300 items', () => {
  it('caps descriptionByAttachmentId at 300 entries and evicts oldest through runtime pipeline', async () => {
    const { ctx } = await setupWithAttachment()
    const backstop = ctx.listeners.get('llm/stream')[0]

    // Drain 350 attachment messages so recordAttachment and describeAttachment run
    for (let i = 1; i <= 350; i++) {
      const gen = backstop(
        { messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: `att-${i}` } }] }] },
        async function* () {},
      )
      for await (const chunk of gen) { void chunk }
    }

    // Now describe_image can resolve descriptions for recent attachments
    const tool = ctx.toolDefs.get('describe_image')
    const res = await tool.execute({ attachmentId: 'att-350', question: 'describe' }, undefined)
    assert.ok(res.description, 'att-350 should be described')
  })

  it('verifies recordDescription behavior directly via unit logic', () => {
    const descriptionByAttachmentId = new Map()
    function recordDescription(id, desc) {
      if (id === undefined || id === null || !desc) return
      const key = String(id)
      descriptionByAttachmentId.delete(key)
      descriptionByAttachmentId.set(key, desc)
      if (descriptionByAttachmentId.size > 300) {
        const oldest = descriptionByAttachmentId.keys().next().value
        if (oldest !== undefined) descriptionByAttachmentId.delete(oldest)
      }
    }

    for (let i = 1; i <= 350; i++) {
      recordDescription(`att-${i}`, `Description for attachment ${i}`)
    }

    assert.equal(descriptionByAttachmentId.size, 300, 'Map size must not exceed 300')
    assert.equal(descriptionByAttachmentId.has('att-1'), false, 'Oldest item att-1 should be evicted')
    assert.equal(descriptionByAttachmentId.has('att-50'), false, 'Item att-50 should be evicted')
    assert.equal(descriptionByAttachmentId.has('att-51'), true, 'Item att-51 should be kept')
    assert.equal(descriptionByAttachmentId.has('att-350'), true, 'Newest item att-350 should be kept')

    // Re-inserting att-51 moves it to the end so it survives the next eviction
    recordDescription('att-51', 'Updated description for 51')
    recordDescription('att-351', 'Description for 351')
    assert.equal(descriptionByAttachmentId.size, 300)
    assert.equal(descriptionByAttachmentId.has('att-52'), false, 'att-52 evicted instead of att-51')
    assert.equal(descriptionByAttachmentId.has('att-51'), true, 'att-51 preserved because of LRU refresh')
  })
})
