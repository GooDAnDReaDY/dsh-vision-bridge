// test/442_composer_buttons_visibility.test.js — Composer buttons visibility settings (#442)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { Config } from '../lib/vision-config.js'
import { apply, plainConfig } from '../lib/index.js'
import { createMockCtx, fakeReq, fakeRes } from './harness.js'

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' }
const clientPath = new URL('../lib/client.js', import.meta.url).pathname
const clientCode = fs.readFileSync(clientPath, 'utf8')

function setupClientHarness(initialConfig = {}) {
  const windowListeners = new Map()
  const documentListeners = new Map()
  const elements = new Map()

  class MockCustomEvent {
    constructor(type, init) {
      this.type = type
      this.detail = init?.detail
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
      return {
        tagName: String(tag).toUpperCase(),
        id: '',
        style: {},
        dataset: {},
        children: [],
        appendChild(c) { this.children.push(c) },
        remove() {},
        addEventListener() {},
        removeEventListener() {},
      }
    },
    getElementById(id) { return elements.get(id) || null },
    querySelector() { return null },
    querySelectorAll() { return [] },
    addEventListener(ev, fn) {
      if (!documentListeners.has(ev)) documentListeners.set(ev, new Set())
      documentListeners.get(ev).add(fn)
    },
    removeEventListener(ev, fn) {
      if (documentListeners.has(ev)) documentListeners.get(ev).delete(fn)
    },
  }

  const win = {
    document: doc,
    navigator: { language: 'en-US' },
    CustomEvent: MockCustomEvent,
    addEventListener(ev, fn) {
      if (!windowListeners.has(ev)) windowListeners.set(ev, new Set())
      windowListeners.get(ev).add(fn)
    },
    removeEventListener(ev, fn) {
      if (windowListeners.has(ev)) windowListeners.get(ev).delete(fn)
    },
    dispatchEvent(ev) {
      const fns = windowListeners.get(ev.type)
      if (fns) {
        for (const fn of Array.from(fns)) fn(ev)
      }
    },
  }

  let loadedModule = null
  win.__ModuleLoader__ = {
    load: (mod) => { loadedModule = mod },
  }

  // Micro-React state & effect tracker
  let hookIndex = 0
  const hookStates = []
  let effectIndex = 0
  const prevDeps = []
  const effectCleanups = []

  const reactMock = {
    useState(init) {
      const idx = hookIndex++
      if (hookStates[idx] === undefined) {
        hookStates[idx] = typeof init === 'function' ? init() : init
      }
      const setter = (val) => {
        hookStates[idx] = typeof val === 'function' ? val(hookStates[idx]) : val
      }
      return [hookStates[idx], setter]
    },
    useEffect(fn, deps) {
      const idx = effectIndex++
      const prev = prevDeps[idx]
      const hasChanged = !prev || !deps || deps.some((d, i) => d !== prev[i])
      if (hasChanged) {
        prevDeps[idx] = deps
        const cleanup = fn()
        if (typeof cleanup === 'function') effectCleanups.push(cleanup)
      }
    },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useRef(v) { return { current: v } },
    useSyncExternalStore(sub, snap) { return snap() },
    Component: class {
      constructor(p) { this.props = p }
      render() { return this.props?.children || null }
    },
    createElement(type, props, ...children) {
      const flatChildren = children.flat().filter((c) => c !== undefined && c !== null && c !== false)
      const childrenProp = flatChildren.length === 0 ? undefined : (flatChildren.length === 1 ? flatChildren[0] : flatChildren)
      if (typeof type === 'function') {
        if (type.prototype && (type.prototype instanceof reactMock.Component || type.prototype.render)) {
          return new type({ ...props, children: childrenProp }).render()
        }
        return type({ ...props, children: childrenProp })
      }
      return { type, props: { ...props, children: flatChildren } }
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

  const sandbox = {
    window: win,
    document: doc,
    navigator: win.navigator,
    CustomEvent: MockCustomEvent,
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
    fetch: async () => ({
      ok: true,
      json: async () => ({
        mode: 'hybrid',
        showVisionModeButton: true,
        showPdfButton: true,
        ...initialConfig,
      }),
    }),
  }

  vm.runInNewContext(clientCode, sandbox)
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
      getSnapshot: () => ({ active: 'en' }),
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
        getSnapshot: () => ({ value: initialConfig }),
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

  const renderSlot = () => {
    hookIndex = 0
    effectIndex = 0
    const slot = registeredSlots.get('conversation.input.right')
    assert.ok(slot, 'conversation.input.right slot must be registered')
    return slot.comp({})
  }

  // Mount once initially to register hooks and listeners
  renderSlot()

  return {
    win,
    doc,
    windowListeners,
    hookStates,
    renderSlot,
    CustomEvent: MockCustomEvent,
  }
}

describe('Issue #442: Composer Vision & PDF buttons visibility toggles', () => {
  describe('1. Config schema defaults and validation', () => {
    it('defaults showVisionModeButton, showModeButton, and showPdfButton to true', () => {
      const parsed = plainConfig(Config({}))
      assert.equal(parsed.showVisionModeButton, true)
      assert.equal(parsed.showModeButton, true)
      assert.equal(parsed.showPdfButton, true)
    })

    it('accepts valid boolean overrides', () => {
      const c1 = plainConfig(Config({ showVisionModeButton: false }))
      assert.equal(c1.showVisionModeButton, false)

      const c2 = plainConfig(Config({ showPdfButton: false }))
      assert.equal(c2.showPdfButton, false)

      const c3 = plainConfig(Config({ showModeButton: false }))
      assert.equal(c3.showModeButton, false)
    })

    it('rejects non-boolean types during schema validation', () => {
      assert.throws(() => Config({ showVisionModeButton: 'false' }))
      assert.throws(() => Config({ showVisionModeButton: 0 }))
      assert.throws(() => Config({ showPdfButton: 'true' }))
      assert.throws(() => Config({ showPdfButton: 1 }))
    })
  })

  describe('2. HTTP route GET & POST /dsh-vision-bridge/config', () => {
    it('GET /config returns default visibility flags as true', async () => {
      const ctx = createMockCtx({ config: {} })
      apply(ctx, ctx.config)

      const route = ctx.routes.get('/dsh-vision-bridge/config')
      assert.ok(route, 'config route must exist')

      const res = fakeRes()
      await route.handler(fakeReq({ method: 'GET', headers: SAME_ORIGIN }), res)
      assert.equal(res.status, 200)
      const data = JSON.parse(res.body)
      assert.equal(data.showVisionModeButton, true)
      assert.equal(data.showModeButton, true)
      assert.equal(data.showPdfButton, true)
    })

    it('POST /config rejects invalid non-boolean types with 400', async () => {
      const ctx = createMockCtx({ config: {} })
      apply(ctx, ctx.config)
      const route = ctx.routes.get('/dsh-vision-bridge/config')

      // showVisionModeButton as string
      const res1 = fakeRes()
      await route.handler(fakeReq({
        method: 'POST',
        headers: SAME_ORIGIN,
        body: JSON.stringify({ showVisionModeButton: 'false' }),
      }), res1)
      assert.equal(res1.status, 400)
      assert.match(res1.body, /showVisionModeButton must be a boolean/)

      // showModeButton as number
      const res2 = fakeRes()
      await route.handler(fakeReq({
        method: 'POST',
        headers: SAME_ORIGIN,
        body: JSON.stringify({ showModeButton: 1 }),
      }), res2)
      assert.equal(res2.status, 400)
      assert.match(res2.body, /showModeButton must be a boolean/)

      // showPdfButton as object
      const res3 = fakeRes()
      await route.handler(fakeReq({
        method: 'POST',
        headers: SAME_ORIGIN,
        body: JSON.stringify({ showPdfButton: {} }),
      }), res3)
      assert.equal(res3.status, 400)
      assert.match(res3.body, /showPdfButton must be a boolean/)
    })

    it('POST /config persists visibility toggles and preserves mode & non-regressed settings', async () => {
      const ctx = createMockCtx({ config: { mode: 'tools' } })
      const storage = {
        ns: 'dsh-vision-bridge',
        revision: 1,
        value: { mode: 'tools' },
      }
      ctx.settings = {
        describe: () => [storage],
        update: async (ns, patch) => {
          storage.value = { ...storage.value, ...patch }
          storage.revision++
        },
      }

      apply(ctx, ctx.config)
      const route = ctx.routes.get('/dsh-vision-bridge/config')

      // 1. Hide Vision button
      const res1 = fakeRes()
      await route.handler(fakeReq({
        method: 'POST',
        headers: SAME_ORIGIN,
        body: JSON.stringify({ showVisionModeButton: false }),
      }), res1)
      assert.equal(res1.status, 200)
      const body1 = JSON.parse(res1.body)
      assert.equal(body1.showVisionModeButton, false)
      assert.equal(body1.showModeButton, false)
      assert.equal(body1.showPdfButton, true)
      assert.equal(body1.mode, 'tools', 'mode must not be changed when toggling vision button')

      // Verify persistence in storage
      assert.equal(storage.value.showVisionModeButton, false)
      assert.equal(storage.value.showModeButton, false)

      // 2. Hide PDF button
      const res2 = fakeRes()
      await route.handler(fakeReq({
        method: 'POST',
        headers: SAME_ORIGIN,
        body: JSON.stringify({ showPdfButton: false }),
      }), res2)
      assert.equal(res2.status, 200)
      const body2 = JSON.parse(res2.body)
      assert.equal(body2.showVisionModeButton, false)
      assert.equal(body2.showPdfButton, false)
      assert.equal(body2.mode, 'tools')

      // 3. GET /config reflects both false
      const res3 = fakeRes()
      await route.handler(fakeReq({ method: 'GET', headers: SAME_ORIGIN }), res3)
      assert.equal(res3.status, 200)
      const body3 = JSON.parse(res3.body)
      assert.equal(body3.showVisionModeButton, false)
      assert.equal(body3.showPdfButton, false)
      assert.equal(body3.mode, 'tools')

      // 4. Re-enable Vision button via showModeButton alias
      const res4 = fakeRes()
      await route.handler(fakeReq({
        method: 'POST',
        headers: SAME_ORIGIN,
        body: JSON.stringify({ showModeButton: true }),
      }), res4)
      assert.equal(res4.status, 200)
      const body4 = JSON.parse(res4.body)
      assert.equal(body4.showVisionModeButton, true)
      assert.equal(body4.showPdfButton, false)
      assert.equal(body4.mode, 'tools')
    })
  })

  describe('3. Client Slot rendering & dynamic visibility toggling', () => {
    it('renders both buttons by default (both flags true)', () => {
      const { renderSlot } = setupClientHarness()
      const tree = renderSlot()

      assert.ok(tree, 'Slot container must be rendered')
      assert.equal(tree.type, 'div')
      assert.equal(tree.props.children.length, 2, 'Should have 2 button children')

      const modeBtn = tree.props.children[0]
      assert.equal(modeBtn.type, 'button')
      assert.match(modeBtn.props.children.join(''), /Vision Mode|👁️/)

      const pdfBtn = tree.props.children[1]
      assert.equal(pdfBtn.type, 'button')
      assert.match(pdfBtn.props.children.join(''), /\+PDF/)
    })

    it('renders only PDF button when showVisionModeButton is false', () => {
      const { renderSlot, win, CustomEvent } = setupClientHarness()

      // Trigger config changed event: hide vision mode button
      win.dispatchEvent(new CustomEvent('dsh-vision-bridge:config-changed', {
        detail: { showVisionModeButton: false, showPdfButton: true },
      }))

      const tree = renderSlot()
      assert.ok(tree, 'Slot container must be rendered')
      assert.equal(tree.type, 'div')
      assert.equal(tree.props.children.length, 1, 'Only 1 button should be present')

      const pdfBtn = tree.props.children[0]
      assert.match(pdfBtn.props.children.join(''), /\+PDF/)
    })

    it('renders only Vision button when showPdfButton is false', () => {
      const { renderSlot, win, CustomEvent } = setupClientHarness()

      // Trigger config changed event: hide PDF button
      win.dispatchEvent(new CustomEvent('dsh-vision-bridge:config-changed', {
        detail: { showVisionModeButton: true, showPdfButton: false },
      }))

      const tree = renderSlot()
      assert.ok(tree, 'Slot container must be rendered')
      assert.equal(tree.type, 'div')
      assert.equal(tree.props.children.length, 1, 'Only 1 button should be present')

      const modeBtn = tree.props.children[0]
      assert.match(modeBtn.props.children.join(''), /Vision Mode|👁️/)
    })

    it('returns null (hides container entirely) when both buttons are false', () => {
      const { renderSlot, win, CustomEvent } = setupClientHarness()

      // Trigger config changed event: hide both buttons
      win.dispatchEvent(new CustomEvent('dsh-vision-bridge:config-changed', {
        detail: { showVisionModeButton: false, showPdfButton: false },
      }))

      const tree = renderSlot()
      assert.equal(tree, null, 'Must return null when both buttons are hidden')
    })

    it('reactively restores buttons when event fires to show them again', () => {
      const { renderSlot, win, CustomEvent } = setupClientHarness()

      // First hide both
      win.dispatchEvent(new CustomEvent('dsh-vision-bridge:config-changed', {
        detail: { showVisionModeButton: false, showPdfButton: false },
      }))
      assert.equal(renderSlot(), null)

      // Re-enable mode button
      win.dispatchEvent(new CustomEvent('dsh-vision-bridge:config-changed', {
        detail: { showVisionModeButton: true, showPdfButton: false },
      }))
      const tree1 = renderSlot()
      assert.ok(tree1)
      assert.equal(tree1.props.children.length, 1)

      // Re-enable PDF button
      win.dispatchEvent(new CustomEvent('dsh-vision-bridge:config-changed', {
        detail: { showVisionModeButton: true, showPdfButton: true },
      }))
      const tree2 = renderSlot()
      assert.ok(tree2)
      assert.equal(tree2.props.children.length, 2)
    })
  })

  describe('4. Non-regression of tools and global handlers', () => {
    it('global PDF drag-and-drop listener remains active when buttons are hidden', () => {
      const { win, windowListeners, renderSlot, CustomEvent } = setupClientHarness()

      // Global drag-and-drop handlers installed on window
      const dragOverListeners = windowListeners.get('dragover')
      const dropListeners = windowListeners.get('drop')

      assert.ok(dragOverListeners && dragOverListeners.size > 0, 'dragover handler must be registered')
      assert.ok(dropListeners && dropListeners.size > 0, 'drop handler must be registered')

      // Hide PDF button
      win.dispatchEvent(new CustomEvent('dsh-vision-bridge:config-changed', {
        detail: { showVisionModeButton: false, showPdfButton: false },
      }))
      assert.equal(renderSlot(), null)

      // Confirm handlers remain attached and intact
      assert.ok(dragOverListeners.size > 0, 'dragover handler must remain attached')
      assert.ok(dropListeners.size > 0, 'drop handler must remain attached')
      assert.equal(typeof win.__vbr_handle_pdf_upload, 'function', 'handlePdfUpload must still exist')
    })

    it('core vision tools remain registered when buttons are hidden in config', () => {
      const ctx = createMockCtx({
        config: {
          showVisionModeButton: false,
          showPdfButton: false,
          mode: 'hybrid',
        },
      })

      apply(ctx, ctx.config)

      // Verify essential vision tools are registered regardless of button visibility
      assert.ok(ctx.toolNames.includes('describe_image'), 'describe_image must be registered')
      assert.ok(ctx.toolNames.includes('read_image'), 'read_image must be registered')
      assert.ok(ctx.toolNames.includes('inspect_image'), 'inspect_image must be registered')
      assert.ok(ctx.toolNames.includes('vision_ocr'), 'vision_ocr must be registered')
      assert.ok(ctx.toolNames.includes('vision_pdf_pages'), 'vision_pdf_pages must be registered')
    })
  })
})
