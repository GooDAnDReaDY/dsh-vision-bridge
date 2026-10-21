import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerCoreTools } from '../lib/tools/core.js'
import { SessionScopedAttachmentMap, extractSessionId } from '../lib/vision-core.js'

describe('Issue #379: Session & Agent Isolation', () => {
  it('SessionScopedAttachmentMap keeps attachments isolated across sessions', () => {
    const map = new SessionScopedAttachmentMap()

    const refA = { id: 'att-A', mediaType: 'image/png' }
    const refB = { id: 'att-B', mediaType: 'image/png' }

    map.set('att-A', refA, 'session-1')
    map.set('att-B', refB, 'session-2')

    // Session 1 can see its own attachment, but not session 2's
    assert.equal(map.has('att-A', 'session-1'), true)
    assert.equal(map.has('att-B', 'session-1'), false)
    assert.equal(map.get('att-A', 'session-1'), refA)
    assert.equal(map.get('att-B', 'session-1'), undefined)
    assert.equal(map.getLast('session-1'), refA)

    // Session 2 can see its own attachment, but not session 1's
    assert.equal(map.has('att-B', 'session-2'), true)
    assert.equal(map.has('att-A', 'session-2'), false)
    assert.equal(map.get('att-B', 'session-2'), refB)
    assert.equal(map.get('att-A', 'session-2'), undefined)
    assert.equal(map.getLast('session-2'), refB)

    // Session 3 has no attachments and does not see session 1 or 2
    assert.equal(map.has('att-A', 'session-3'), false)
    assert.equal(map.has('att-B', 'session-3'), false)
    assert.equal(map.getLast('session-3'), null)
  })

  it('vision_inspect without source isolates fallback by session ID', async () => {
    const registeredTools = new Map()
    const attachmentMap = new SessionScopedAttachmentMap()

    const refA = { id: 'att-A', mediaType: 'image/png' }
    const refB = { id: 'att-B', mediaType: 'image/png' }

    attachmentMap.set('att-A', refA, 'sess-A')
    attachmentMap.set('att-B', refB, 'sess-B')

    const readCalls = []
    const mockCtx = {
      tools: {
        register: (tool) => registeredTools.set(tool.name, tool),
      },
      get: (service) => null,
      attachments: {
        readImage: async (ref) => {
          readCalls.push(ref.id)
          return { data: Buffer.from('data-' + ref.id) }
        },
      },
    }

    registerCoreTools({
      ctx: mockCtx,
      config: { timeoutMs: 5000 },
      attachmentById: attachmentMap,
      callVisionModelWithBytes: async () => ({ description: 'test-description' }),
      describeImage: async () => ({ description: 'test-description' }),
      resolveImageBytes: async (ref) => ({ bytes: Buffer.from('bytes'), contentType: 'image/png' }),
      extractSessionId,
    })

    const tool = registeredTools.get('vision_inspect')
    assert.ok(tool)

    // Call from session A without source -> should get att-A
    await tool.execute({ mode: 'describe' }, { session: { id: 'sess-A' } })
    assert.equal(readCalls.pop(), 'att-A')

    // Call from session B without source -> should get att-B
    await tool.execute({ mode: 'describe' }, { session: { id: 'sess-B' } })
    assert.equal(readCalls.pop(), 'att-B')

    // Call from session C without source -> should NOT get att-A or att-B, must throw
    await assert.rejects(async () => {
      await tool.execute({ mode: 'describe' }, { session: { id: 'sess-C' } })
    }, /vision_inspect: source is required/)

    // Call from session A requesting att-B -> should NOT be found
    await assert.rejects(async () => {
      await tool.execute({ source: 'att-B', mode: 'describe' }, { session: { id: 'sess-A' } })
    }, /vision_inspect: could not resolve "att-B"/)
  })
})
