import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const clientPath = new URL('../lib/client.js', import.meta.url).pathname
const clientCode = fs.readFileSync(clientPath, 'utf8')

describe('issue #335: plugins.row.config slot registration and view-aware rendering', () => {
  it('static analysis verifies ROW_CONFIG_KEY, slot names, and absence of settings.section', () => {
    // ROW_CONFIG_KEY must be exactly @goodandready/dsh-vision-bridge#dsh-vision-bridge
    assert.match(clientCode, /const PKG = '@goodandready\/dsh-vision-bridge'/)
    assert.match(clientCode, /const ROW_ID = 'dsh-vision-bridge'/)
    assert.match(clientCode, /const ROW_CONFIG_KEY = PKG \+ '#' \+ ROW_ID/)

    // plugins.row.config must be registered first
    const rowIdx = clientCode.indexOf("'plugins.row.config'")
    const itemIdx = clientCode.indexOf("'plugins.item'")
    const fallbackIdx = clientCode.indexOf("'settings.plugin.item'")

    assert.ok(rowIdx > 0, 'plugins.row.config must be present')
    assert.ok(fallbackIdx > 0, 'settings.plugin.item must be present as fallback')
    assert.ok(rowIdx < fallbackIdx, 'plugins.row.config must be registered before settings.plugin.item')

    // settings.section must NOT be registered
    assert.equal(clientCode.includes("'settings.section'"), false, 'settings.section must be absent')
    assert.equal(clientCode.includes('"settings.section"'), false, 'settings.section must be absent')
  })

  it('registers plugins.row.config with correct key and preserves settings.plugin.item fallback', () => {
    const registeredSlots = []
    const mockCtx = {
      slots: {
        inject(name, cb) { cb() },
        register(meta, comp) { registeredSlots.push({ meta, comp }) },
      },
      locale: {
        register() {},
        getSnapshot() { return { active: 'en' } },
        subscribe() { return () => {} },
      },
      configForms: {
        get() {
          return {
            getSnapshot() { return { value: {} } },
            subscribe() { return () => {} },
            update: async () => {},
          }
        },
      },
      effect(fn) { fn() },
    }

    let loadedModule = null
    const document = {
      head: { appendChild() {} },
      createElement() { return { setAttribute() {}, style: {}, dataset: {}, appendChild() {} } },
      getElementById() { return null },
      querySelector() { return null },
      querySelectorAll() { return [] },
      addEventListener() {},
      removeEventListener() {},
    }
    const window = {
      document,
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: {
        load({ id, factory }) { loadedModule = { id, factory } },
      },
    }

    const reactMock = {
      useState(v) { return [typeof v === 'function' ? v() : v, () => {}] },
      useEffect() {},
      useMemo(fn) { return fn() },
      useCallback(fn) { return fn },
      useRef(v) { return { current: v } },
      useSyncExternalStore(sub, snap) { return snap() },
      createElement(type, props, ...children) {
        return { type, props: { ...props, children: children.flat().filter(Boolean) } }
      },
      Component: class {
        constructor(p) { this.props = p }
        render() { return this.props.children || null }
      },
    }

    const fakeRequire = (m) => {
      if (m === 'react') return reactMock
      if (m === 'react/jsx-runtime') {
        return {
          jsx: (type, props) => ({ type, props }),
          jsxs: (type, props) => ({ type, props }),
          Fragment: 'react.fragment',
        }
      }
      return {}
    }

    const context = {
      window,
      document,
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
      Symbol,
      Error,
      fetch: async () => ({ ok: true, json: async () => ({}) }),
    }

    vm.runInNewContext(clientCode, context)
    assert.ok(loadedModule, 'ModuleLoader.load must be called')
    const clientExports = loadedModule.factory(fakeRequire)
    clientExports.apply(mockCtx)

    const slotNames = registeredSlots.map((s) => s.meta.name)
    assert.ok(slotNames.includes('plugins.row.config'), 'plugins.row.config must be registered')
    assert.ok(slotNames.includes('settings.plugin.item'), 'settings.plugin.item must be registered as fallback')
    assert.equal(slotNames.includes('settings.section'), false, 'settings.section must not be registered')

    // First settings slot registered must be plugins.row.config
    const firstSettingsSlot = registeredSlots.find((s) => s.meta.name.startsWith('plugins.') || s.meta.name.startsWith('settings.'))
    assert.equal(firstSettingsSlot.meta.name, 'plugins.row.config')
    assert.equal(firstSettingsSlot.meta.key, '@goodandready/dsh-vision-bridge#dsh-vision-bridge')
  })

  it('renders bare form when view is page and summary string when view is summary', () => {
    const registeredSlots = new Map()
    const mockCtx = {
      slots: {
        inject(name, cb) { cb() },
        register(meta, comp) { registeredSlots.set(meta.name, { meta, comp }) },
      },
      locale: {
        register() {},
        getSnapshot() { return { active: 'en' } },
        subscribe() { return () => {} },
      },
      configForms: {
        get() {
          return {
            getSnapshot() { return { value: {} } },
            subscribe() { return () => {} },
            update: async () => {},
          }
        },
      },
      effect(fn) { fn() },
    }

    let loadedModule = null
    const document = {
      head: { appendChild() {} },
      createElement() { return { setAttribute() {}, style: {}, dataset: {}, appendChild() {} } },
      getElementById() { return null },
      querySelector() { return null },
      querySelectorAll() { return [] },
      addEventListener() {},
      removeEventListener() {},
    }
    const window = {
      document,
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: {
        load({ id, factory }) { loadedModule = { id, factory } },
      },
    }

    const reactMock = {
      useState(v) { return [typeof v === 'function' ? v() : v, () => {}] },
      useEffect() {},
      useMemo(fn) { return fn() },
      useCallback(fn) { return fn },
      useRef(v) { return { current: v } },
      useSyncExternalStore(sub, snap) { return snap() },
      createElement(type, props, ...children) {
        return { type, props: { ...props, children: children.flat().filter(Boolean) } }
      },
      Component: class {
        constructor(p) { this.props = p }
        render() { return this.props.children || null }
      },
    }

    const fakeRequire = (m) => {
      if (m === 'react') return reactMock
      if (m === 'react/jsx-runtime') {
        return {
          jsx: (type, props) => ({ type, props }),
          jsxs: (type, props) => ({ type, props }),
          Fragment: 'react.fragment',
        }
      }
      return {}
    }

    const context = {
      window,
      document,
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
      Symbol,
      Error,
      fetch: async () => ({ ok: true, json: async () => ({}) }),
    }

    vm.runInNewContext(clientCode, context)
    const clientExports = loadedModule.factory(fakeRequire)
    clientExports.apply(mockCtx)

    const rowSlot = registeredSlots.get('plugins.row.config')
    assert.ok(rowSlot, 'plugins.row.config must exist')

    // 1. view === 'summary'
    const summaryWrapper = rowSlot.comp({ ctx: mockCtx, view: 'summary' })
    const summaryCardComp = summaryWrapper.props.children[0]
    const summaryRender = summaryCardComp.type({ ctx: mockCtx, view: 'summary' })
    assert.equal(summaryRender.type, 'span')
    assert.equal(summaryRender.props.className, 'vbr-card-description')

    // 2. view === 'page' -> bare render, no button header, container has vbr-page
    const pageWrapper = rowSlot.comp({ ctx: mockCtx, view: 'page' })
    const pageCardComp = pageWrapper.props.children[0]
    const pageRender = pageCardComp.type({ ctx: mockCtx, view: 'page' })
    assert.equal(pageRender.type, 'div')
    assert.equal(pageRender.props.className, 'vbr-page')
    // Must NOT contain header button
    const hasHeaderBtn = pageRender.props.children && pageRender.props.children.some((c) => c && c.type === 'button')
    assert.equal(hasHeaderBtn, false, 'page view must be bare and have no card header button')
  })
})
