import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveOcrLanguage, registerOcrTools } from '../lib/tools/ocr.js'
import { runLocalOCR } from '../lib/vision-core.js'
import { getTesseractLanguages } from '../lib/process.js'

test('issue #404: resolveOcrLanguage canonical defaults and language mappings', () => {
  // Default must be eng, never rus or eng+rus
  assert.equal(resolveOcrLanguage(undefined), 'eng')
  assert.equal(resolveOcrLanguage(''), 'eng')
  assert.equal(resolveOcrLanguage(null), 'eng')

  // Chinese aliases
  assert.equal(resolveOcrLanguage('zh'), 'chi_sim')
  assert.equal(resolveOcrLanguage('zh-cn'), 'chi_sim')
  assert.equal(resolveOcrLanguage('zh-hans'), 'chi_sim')
  assert.equal(resolveOcrLanguage('chinese'), 'chi_sim')
  assert.equal(resolveOcrLanguage('zh-tw'), 'chi_tra')
  assert.equal(resolveOcrLanguage('zh-hant'), 'chi_tra')

  // Combination with English
  assert.equal(resolveOcrLanguage('eng+zh'), 'eng+chi_sim')
  assert.equal(resolveOcrLanguage('en+chi_sim'), 'eng+chi_sim')

  // Explicit languages preserved
  assert.equal(resolveOcrLanguage('rus'), 'rus')
  assert.equal(resolveOcrLanguage('rus+eng'), 'rus+eng')
  assert.equal(resolveOcrLanguage('fra'), 'fra')
  assert.equal(resolveOcrLanguage('deu'), 'deu')
})

test('issue #404: runLocalOCR default parameter is canonical English', async () => {
  // Check function default parameter string or signature
  const fnStr = runLocalOCR.toString()
  assert.ok(!fnStr.includes("lang = 'rus+eng'"), 'runLocalOCR must not default to rus+eng')
})

test('issue #404: vision_ocr and vision_ocr_local parameter specs have no Russian default', () => {
  const registered = new Map()
  const mockCtx = {
    tools: {
      register(tool) {
        registered.set(tool.name, tool)
      },
    },
  }
  registerOcrTools({
    ctx: mockCtx,
    config: { timeoutMs: 5000, ocrLang: 'eng' },
    attachmentById: new Map(),
    tesseractAvailable: async () => true,
  })

  const ocr = registered.get('vision_ocr')
  assert.ok(ocr, 'vision_ocr registered')
  const ocrLangDesc = ocr.parameters?.properties?.lang?.description || ''
  assert.ok(!ocrLangDesc.includes('default eng+rus'), 'vision_ocr description must not default to eng+rus')

  const ocrLocal = registered.get('vision_ocr_local')
  assert.ok(ocrLocal, 'vision_ocr_local registered')
  const localLangDesc = ocrLocal.parameters?.properties?.lang?.description || ''
  assert.ok(!localLangDesc.includes('default eng+rus'), 'vision_ocr_local description must not default to eng+rus')
})

test('issue #404: vision_ocr falls back to vision LLM when requested tesseract pack is missing', async () => {
  const registered = new Map()
  let llmPromptCalled = false
  const mockCtx = {
    tools: {
      register(tool) {
        registered.set(tool.name, tool)
      },
    },
  }
  registerOcrTools({
    ctx: mockCtx,
    config: { timeoutMs: 5000, ocrLang: 'eng' },
    attachmentById: new Map([['att-1', { id: 'att-1' }]]),
    resolveImageBytes: async () => ({ bytes: Buffer.from('fake'), contentType: 'image/png' }),
    callVisionModelWithBytes: async () => {
      llmPromptCalled = true
      return { description: 'chinese text extracted via llm' }
    },
    tesseractAvailable: async () => true,
  })

  const ocr = registered.get('vision_ocr')
  // Request non-existent pack 'nonexistent_lang' with auto engine
  const res = await ocr.execute({ attachmentId: 'att-1', lang: 'nonexistent_lang', engine: 'auto' })
  assert.equal(res.engine, 'vision-llm')
  assert.equal(res.text, 'chinese text extracted via llm')
  assert.ok(res.warnings.some(w => w.includes('nonexistent_lang')), 'Warning mentions missing language pack')
  assert.ok(llmPromptCalled, 'Vision LLM was called')
})

test('issue #404: vision_ocr_local reports unavailable language pack truthfully', async () => {
  const registered = new Map()
  const mockCtx = {
    tools: {
      register(tool) {
        registered.set(tool.name, tool)
      },
    },
  }
  registerOcrTools({
    ctx: mockCtx,
    config: { timeoutMs: 5000, ocrLang: 'eng' },
    attachmentById: new Map([['att-1', { id: 'att-1' }]]),
    resolveImageBytes: async () => ({ bytes: Buffer.from('fake'), contentType: 'image/png' }),
    tesseractAvailable: async () => true,
  })

  const ocrLocal = registered.get('vision_ocr_local')
  const res = await ocrLocal.execute({ attachmentId: 'att-1', lang: 'nonexistent_pack' })
  assert.equal(res.text, '')
  assert.ok(res.engine.includes('nonexistent_pack'), 'Engine reports missing language pack')
  assert.ok(res.engine.includes('unavailable'), 'Engine reports unavailable')
})
