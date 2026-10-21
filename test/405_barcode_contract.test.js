import test from 'node:test'
import assert from 'node:assert/strict'
import { setupWithAttachment } from './harness.js'

test('vision_scan_barcode contract and behavior (#405)', async (t) => {
  const dummyBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  await t.test('tool description does not promise zero VLM overhead', async () => {
    const { ctx } = await setupWithAttachment({
      imageBytes: dummyBytes,
      config: { mode: 'hybrid' },
    })
    const tool = ctx.toolDefs.get('vision_scan_barcode')
    assert.ok(tool)
    assert.equal(tool.description.includes('without VLM'), false)
    assert.equal(tool.description.includes('token overhead'), false)
    assert.ok(tool.description.includes('visual model inspection'))
  })

  await t.test('returns parsed barcode when found', async () => {
    const { ctx } = await setupWithAttachment({
      imageBytes: dummyBytes,
      config: { mode: 'hybrid' },
    })

    ctx.llm.stream = async function* () {
      yield {
        type: 'text-delta',
        text: JSON.stringify({
          found: true,
          codes: [
            { type: 'QR', value: 'https://example.com/item/123', location: 'center' },
          ],
        }),
      }
    }

    const tool = ctx.toolDefs.get('vision_scan_barcode')
    const res = await tool.execute({ attachmentId: 'att-1', type: 'qr' })

    assert.equal(res.found, true)
    assert.equal(res.codes.length, 1)
    assert.equal(res.codes[0].type, 'QR')
    assert.equal(res.codes[0].value, 'https://example.com/item/123')
  })

  await t.test('returns found false when none found or unreadable', async () => {
    const { ctx } = await setupWithAttachment({
      imageBytes: dummyBytes,
      config: { mode: 'hybrid' },
    })

    ctx.llm.stream = async function* () {
      yield {
        type: 'text-delta',
        text: JSON.stringify({
          found: false,
          codes: [],
        }),
      }
    }

    const tool = ctx.toolDefs.get('vision_scan_barcode')
    const res = await tool.execute({ attachmentId: 'att-1' })

    assert.equal(res.found, false)
    assert.deepEqual(res.codes, [])
  })
})

