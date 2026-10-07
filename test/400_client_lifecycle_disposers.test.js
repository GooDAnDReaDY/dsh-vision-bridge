// test/400_client_lifecycle_disposers.test.js — Client lifecycle disposers & cleanup (#400)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const clientPath = new URL('../lib/client.js', import.meta.url).pathname
const clientCode = fs.readFileSync(clientPath, 'utf8')

function createMockDom() {
  const listeners = {
    document: new Map(),
    window: new Map(),
  }

  const elements = new Map()

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
        appendChild(child) { el.children.push(child) },
        remove() {
          if (el.id) elements.delete(el.id)
        },
        addEventListener() {},
        removeEventListener() {},
      }
      return el
    },
    getElementById(id) { return elements.get(id) || null },
    querySelector() { return null },
    querySelectorAll() { return [] },
    addEventListener(ev, fn, capture) {
      const key = ev + ':' + !!capture
      if (!listeners.document.has(key)) listeners.document.set(key, new Set())
      listeners.document.get(key).add(fn)
    },
    removeEventListener(ev, fn, capture) {
      const key = ev + ':' + !!capture
      if (listeners.document.has(key)) listeners.document.get(key).delete(fn)
    },
  }

  const win = {
    document: doc,
    addEventListener(ev, fn, capture) {
      const key = ev + ':' + !!capture
      if (!listeners.window.has(key)) listeners.window.set(key, new Set())
      listeners.window.get(key).add(fn)
    },
    removeEventListener(ev, fn, capture) {
      const key = ev + ':' + !!capture
      if (listeners.window.has(key)) listeners.window.get(key).delete(fn)
    },
  }

  return { doc, win, listeners, elements }
}

function loadModule(win, doc) {
  let loadedModule = null
  win.__ModuleLoader__ = {
    load: (mod) => { loadedModule = mod },
  }

  const sandbox = {
    window: win,
    document: doc,
    navigator: { language: 'en-US' },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  }

  vm.runInNewContext(clientCode, sandbox)

  const fakeRequire = (id) => {
    if (id === 'react') {
      return {
        useState: (init) => [init, () => {}],
        useEffect: () => {},
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
        useRef: (v) => ({ current: v }),
        useSyncExternalStore: (s, snap) => snap(),
        createElement: (type, props) => ({ type, props }),
        Component: class { render() { return null } },
      }
    }
    if (id === 'react/jsx-runtime') {
      return {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
        Fragment: 'Fragment',
      }
    }
    return {}
  }

  return loadedModule.factory(fakeRequire)
}

describe('#400 Client global handlers and locale disposer cleanup', () => {
  it('cleans up DOM event listeners and invokes locale disposer on unmount', () => {
    const { doc, win, listeners } = createMockDom()
    const clientExports = loadModule(win, doc)

    let dictionaryDisposed = 0
    const registeredSlots = new Map()
    const disposers = []

    const mockCtx = {
      get: (name) => {
        if (name === 'slots') return mockCtx.slots
        if (name === 'locale') return mockCtx.locale
        return null
      },
      locale: {
        subscribe: () => () => {},
        getSnapshot: () => ({ active: 'en' }),
        register: () => () => {
          dictionaryDisposed += 1
        },
      },
      slots: {
        inject: (name, fn) => {
          fn()
          return () => { registeredSlots.delete(name) }
        },
        register: (meta) => {
          registeredSlots.set(meta.name, meta)
        },
      },
      effect: (fn) => {
        const disp = fn()
        if (typeof disp === 'function') disposers.push(disp)
      },
    }

    clientExports.apply(mockCtx)

    // Check listeners were added
    assert.ok(listeners.document.get('click:true')?.size > 0, 'document click listener must be attached')
    assert.ok(listeners.window.get('dragover:false')?.size > 0, 'window dragover listener must be attached')
    assert.ok(listeners.window.get('drop:true')?.size > 0, 'window drop listener must be attached')
    assert.equal(win.__vbr_lightbox_installed, true)
    assert.equal(win.__vbr_pdf_drag_installed, true)
    assert.equal(registeredSlots.size > 0, true, 'Slots must be registered')

    // Execute all effect disposers (simulating unmount)
    for (const d of disposers) d()

    // Verify all listeners removed
    assert.equal(listeners.document.get('click:true')?.size || 0, 0, 'document click listener must be removed')
    assert.equal(listeners.window.get('dragover:false')?.size || 0, 0, 'window dragover listener must be removed')
    assert.equal(listeners.window.get('drop:true')?.size || 0, 0, 'window drop listener must be removed')
    assert.equal(dictionaryDisposed, 1, 'locale register disposer must be called exactly once')
    assert.equal(win.__vbr_lightbox_installed, false, 'lightbox flag must be reset')
    assert.equal(win.__vbr_pdf_drag_installed, false, 'drag flag must be reset')
  })

  it('allows clean re-application (apply -> dispose -> apply lifecycle)', () => {
    const { doc, win, listeners } = createMockDom()
    const clientExports = loadModule(win, doc)

    let dictionaryRegisteredCount = 0
    let dictionaryDisposedCount = 0
    let disposers = []

    const mockCtx = {
      get: (name) => {
        if (name === 'slots') return mockCtx.slots
        if (name === 'locale') return mockCtx.locale
        return null
      },
      locale: {
        subscribe: () => () => {},
        getSnapshot: () => ({ active: 'en' }),
        register: () => {
          dictionaryRegisteredCount += 1
          return () => { dictionaryDisposedCount += 1 }
        },
      },
      slots: {
        inject: (name, fn) => fn(),
        register: () => {},
      },
      effect: (fn) => {
        const disp = fn()
        if (typeof disp === 'function') disposers.push(disp)
      },
    }

    // Pass 1: apply
    clientExports.apply(mockCtx)
    assert.equal(dictionaryRegisteredCount, 1)

    // Dispose
    for (const d of disposers) d()
    assert.equal(dictionaryDisposedCount, 1)

    // Pass 2: apply again (must NOT be blocked by applied flag!)
    disposers = []
    clientExports.apply(mockCtx)
    assert.equal(dictionaryRegisteredCount, 2, 'Must re-register dictionary and slots on re-apply')
    assert.equal(listeners.document.get('click:true')?.size > 0, true, 'document click listener must be re-attached')
  })
})
