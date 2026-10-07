// test/408_pdf_composer_binding.test.js — PDF import composer image attachment binding (#408)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const clientPath = new URL('../lib/client.js', import.meta.url).pathname
const clientCode = fs.readFileSync(clientPath, 'utf8')

function createMockEnvironment({ fetchResult, locale = 'en' } = {}) {
  const elements = new Map()
  const customEvents = []
  let activeElement = null

  const textarea = {
    tagName: 'TEXTAREA',
    value: '',
    textContent: '',
    dispatchEvent: (ev) => {
      customEvents.push(ev)
    },
  }
  activeElement = textarea

  class MockCustomEvent {
    constructor(type, init) {
      this.type = type
      this.bubbles = !!init?.bubbles
      this.detail = init?.detail
    }
  }

  class MockClipboardEvent {
    constructor(type, init) {
      this.type = type
      this.clipboardData = init?.clipboardData
    }
  }

  class MockDataTransfer {
    constructor() {
      this.items = {
        add: () => {},
      }
    }
  }

  const doc = {
    head: { appendChild() {} },
    body: {
      appendChild(el) {
        if (el && el.id) elements.set(el.id, el)
      },
    },
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        id: '',
        style: {},
        dataset: {},
        children: [],
        textContent: '',
        appendChild(child) { el.children.push(child) },
        remove() {
          if (el.id) elements.delete(el.id)
        },
        dispatchEvent(ev) {
          customEvents.push(ev)
        },
        addEventListener() {},
        removeEventListener() {},
      }
      return el
    },
    getElementById(id) { return elements.get(id) || null },
    querySelector(selector) {
      if (selector.includes('textarea')) return textarea
      return null
    },
    querySelectorAll() { return [] },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(ev) {
      customEvents.push(ev)
    },
  }

  const win = {
    document: doc,
    navigator: { language: locale === 'zh' ? 'zh-CN' : 'en-US' },
    CustomEvent: MockCustomEvent,
    ClipboardEvent: MockClipboardEvent,
    DataTransfer: MockDataTransfer,
    Blob: globalThis.Blob || class Blob {},
    File: class MockFile {},
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    addEventListener() {},
    removeEventListener() {},
  }

  let loadedModule = null
  win.__ModuleLoader__ = {
    load: (mod) => { loadedModule = mod },
  }

  const mockFetch = async (url, opts) => {
    if (typeof fetchResult === 'function') {
      return fetchResult(url, opts)
    }
    return {
      ok: true,
      json: async () => fetchResult || {
        ok: true,
        count: 2,
        pages: [
          { attachmentId: 'att-page-1', name: 'sample-page-1.png', bytes: 1024 },
          { attachmentId: 'att-page-2', name: 'sample-page-2.png', bytes: 2048 },
        ],
      },
    }
  }

  const sandbox = {
    window: win,
    document: doc,
    navigator: win.navigator,
    CustomEvent: MockCustomEvent,
    ClipboardEvent: MockClipboardEvent,
    DataTransfer: MockDataTransfer,
    Blob: win.Blob,
    File: win.File,
    atob: win.atob,
    console,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Uint8Array,
    fetch: mockFetch,
  }

  vm.runInNewContext(clientCode, sandbox)

  const reactMock = {
    useState: (init) => [init, () => {}],
    useEffect: (fn) => { fn() },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    useSyncExternalStore: (s, snap) => snap(),
    Component: class MockComponent {
      constructor(p) { this.props = p }
      render() { return this.props?.children || null }
    },
    createElement: (type, props, ...children) => {
      const allChildren = children.flat().filter(Boolean)
      if (typeof type === 'function') {
        if (type.prototype && (type.prototype instanceof reactMock.Component || type.prototype.render)) {
          const inst = new type({ ...props, children: allChildren })
          return inst.render()
        }
        return type({ ...props, children: allChildren })
      }
      return { type, props: { ...props, children: allChildren } }
    },
  }

  const fakeRequire = (id) => {
    if (id === 'react') return reactMock
    if (id === 'react/jsx-runtime') {
      return {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
        Fragment: 'Fragment',
      }
    }
    return {}
  }

  const clientExports = loadedModule.factory(fakeRequire)

  const registeredSlots = new Map()
  const mockCtx = {
    get: (name) => {
      if (name === 'slots') return mockCtx.slots
      if (name === 'locale') return mockCtx.locale
      return null
    },
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => ({ active: locale }),
      register: () => () => {},
    },
    slots: {
      inject: (name, fn) => {
        fn()
        return () => { registeredSlots.delete(name) }
      },
      register: (meta, comp) => {
        registeredSlots.set(meta.name, { meta, comp })
      },
    },
    configForms: {
      get: () => ({
        getSnapshot: () => ({ value: {} }),
        subscribe: () => () => {},
        update: async () => {},
      }),
    },
    effect: (fn) => {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
  }

  clientExports.apply(mockCtx)

  return {
    doc,
    win,
    textarea,
    elements,
    customEvents,
    mockCtx,
    registeredSlots,
  }
}

describe('#408 PDF Composer Image Attachment Binding', () => {
  it('binds returned attachmentId pages to inputActions.addAttachments without plain text injection into textarea', async () => {
    const { win, textarea, customEvents, registeredSlots, elements } = createMockEnvironment()

    const added = []
    const inputActions = {
      addAttachments: (ids) => {
        added.push(...ids)
      },
    }

    const inputSlot = registeredSlots.get('conversation.input.right')
    assert.ok(inputSlot, 'conversation.input.right slot must be registered')

    // Simulate rendering slot with composer inputActions
    inputSlot.comp({ inputActions })

    // Invoke PDF upload handler
    assert.ok(typeof win.__vbr_handle_pdf_upload === 'function', 'handlePdfUpload must be exposed')
    await win.__vbr_handle_pdf_upload({ name: 'contract.pdf' })

    // 1. inputActions.addAttachments must be called with exact IDs
    assert.deepEqual(added, ['att-page-1', 'att-page-2'])

    // 2. textarea.value must NOT contain plaintext [Attachment: ...]
    assert.equal(textarea.value, '', 'Textarea value must remain empty')
    assert.equal(textarea.textContent, '', 'Textarea textContent must remain empty')

    // 3. Fallback event and global store must be populated
    assert.deepEqual(Array.from(win.__vbr_composer_attachments || []), ['att-page-1', 'att-page-2'])
    const attachEv = customEvents.find((e) => e.type === 'dsh:add-attachments')
    assert.ok(attachEv, 'dsh:add-attachments event must be dispatched')
    assert.deepEqual(Array.from(attachEv.detail.attachmentIds || []), ['att-page-1', 'att-page-2'])

    // 4. Toast notification was created and loaded message shown
    const toast = elements.get('vbr-pdf-toast')
    assert.ok(toast, 'Toast element must exist')
    assert.equal(toast.textContent, '✅ Loaded 2 PDF pages')
  })

  it('supports inputActions.addAttachment singular fallback', async () => {
    const { win, textarea, registeredSlots } = createMockEnvironment()

    const added = []
    const inputActions = {
      addAttachment: (id) => {
        added.push(id)
      },
    }

    const inputSlot = registeredSlots.get('conversation.input.right')
    inputSlot.comp({ inputActions })

    await win.__vbr_handle_pdf_upload({ name: 'presentation.pdf' })

    assert.deepEqual(added, ['att-page-1', 'att-page-2'])
    assert.equal(textarea.value, '')
  })

  it('localizes toast notifications in Chinese locale', async () => {
    const { win, elements } = createMockEnvironment({ locale: 'zh' })

    await win.__vbr_handle_pdf_upload({ name: 'chinese.pdf' })

    const toast = elements.get('vbr-pdf-toast')
    assert.ok(toast, 'Toast element must exist')
    assert.equal(toast.textContent, '✅ 已加载 2 个 PDF 页面')
  })

  it('displays localized error toast on upload failure', async () => {
    const { win, elements } = createMockEnvironment({
      fetchResult: () => ({
        ok: false,
        json: async () => ({ ok: false, error: 'Corrupt PDF header' }),
      }),
    })

    await win.__vbr_handle_pdf_upload({ name: 'corrupted.pdf' })

    const toast = elements.get('vbr-pdf-toast')
    assert.ok(toast, 'Toast element must exist')
    assert.match(toast.textContent, /❌ PDF error: Corrupt PDF header/)
  })

  it('dispatches clipboard paste event when page provides dataUrl', async () => {
    const pastedEvents = []
    const { win, textarea } = createMockEnvironment({
      fetchResult: {
        ok: true,
        count: 1,
        pages: [
          { name: 'rendered.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
        ],
      },
    })

    textarea.dispatchEvent = (ev) => {
      if (ev.type === 'paste') pastedEvents.push(ev)
    }

    await win.__vbr_handle_pdf_upload({ name: 'rendered.pdf' })

    assert.equal(pastedEvents.length, 1, 'Paste event must be dispatched for dataUrl')
    assert.equal(textarea.value, '', 'Textarea value must remain empty')
  })
})
