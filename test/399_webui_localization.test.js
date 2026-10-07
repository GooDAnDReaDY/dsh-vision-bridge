// test/399_webui_localization.test.js — WebUI localization & slot translator (#399)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const clientPath = new URL('../lib/client.js', import.meta.url).pathname
const clientCode = fs.readFileSync(clientPath, 'utf8')

function createTestRenderer() {
  const componentInstances = new Map()
  let currentInstance = null
  const pendingEffects = []

  function getOrCreateInstance(id) {
    if (!componentInstances.has(id)) {
      componentInstances.set(id, { hooks: [], hookIndex: 0, stateSetters: [] })
    }
    return componentInstances.get(id)
  }

  const reactMock = {
    useState(initial) {
      if (!currentInstance) throw new Error('useState called outside component render')
      const inst = currentInstance
      const idx = inst.hookIndex++
      if (inst.hooks.length <= idx) {
        const val = typeof initial === 'function' ? initial() : initial
        inst.hooks.push(val)
      }
      const setter = (val) => {
        inst.hooks[idx] = typeof val === 'function' ? val(inst.hooks[idx]) : val
      }
      inst.stateSetters[idx] = setter
      return [inst.hooks[idx], setter]
    },
    useEffect(fn, deps) {
      if (!currentInstance) throw new Error('useEffect called outside component render')
      const inst = currentInstance
      const idx = inst.hookIndex++
      pendingEffects.push({ fn, deps, inst, idx })
    },
    useMemo(fn, deps) {
      if (!currentInstance) return fn()
      const inst = currentInstance
      const idx = inst.hookIndex++
      if (inst.hooks.length <= idx) {
        inst.hooks.push({ value: fn(), deps })
      }
      return inst.hooks[idx].value
    },
    useCallback(fn, deps) {
      return reactMock.useMemo(() => fn, deps)
    },
    useRef(val) {
      if (!currentInstance) return { current: val }
      const inst = currentInstance
      const idx = inst.hookIndex++
      if (inst.hooks.length <= idx) {
        inst.hooks.push({ current: val })
      }
      return inst.hooks[idx]
    },
    useSyncExternalStore(sub, snap) {
      return snap()
    },
    createElement(type, props, ...children) {
      let resolvedChildren = []
      if (children.length > 0) {
        resolvedChildren = children.flat().filter(Boolean)
      } else if (props && props.children) {
        resolvedChildren = Array.isArray(props.children) ? props.children.flat().filter(Boolean) : [props.children]
      }
      return {
        type,
        props: { ...props, children: resolvedChildren },
        _isReactElement: true,
      }
    },
    Component: class Component {
      constructor(p) { this.props = p; this.state = {} }
      setState(s) { Object.assign(this.state, s) }
      render() { return this.props.children || null }
    },
  }

  function renderComponent(fn, props, id = fn.name || 'AnonymousComponent') {
    const inst = getOrCreateInstance(id)
    inst.hookIndex = 0
    const prevInstance = currentInstance
    currentInstance = inst
    try {
      return fn(props)
    } finally {
      currentInstance = prevInstance
    }
  }

  return { reactMock, renderComponent }
}

function setupEnv(activeLocale = 'en') {
  let loadedModule = null
  const renderer = createTestRenderer()
  const registeredSlots = new Map()

  const doc = {
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement() {
      return { tagName: 'DIV', style: {}, dataset: {}, appendChild() {}, addEventListener() {}, removeEventListener() {} }
    },
    getElementById() { return null },
    querySelector() { return null },
    querySelectorAll() { return [] },
    addEventListener() {},
    removeEventListener() {},
  }

  const win = {
    document: doc,
    navigator: { language: activeLocale },
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: {
      load: (mod) => { loadedModule = mod },
    },
  }

  const sandbox = {
    window: win,
    document: doc,
    navigator: win.navigator,
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
    if (id === 'react') return renderer.reactMock
    if (id === 'react/jsx-runtime') {
      return {
        jsx: renderer.reactMock.createElement,
        jsxs: renderer.reactMock.createElement,
        Fragment: 'Fragment',
      }
    }
    return {}
  }

  const clientExports = loadedModule.factory(fakeRequire)

  const mockCtx = {
    get: (name) => {
      if (name === 'slots') return mockCtx.slots
      if (name === 'locale') return mockCtx.locale
      return null
    },
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => ({ active: activeLocale }),
      register: () => () => {},
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, component) => {
        registeredSlots.set(meta.name, { meta, component })
      },
    },
    effect: (fn) => fn(),
  }

  clientExports.apply(mockCtx)

  return { renderer, registeredSlots, mockCtx }
}

function renderSlotChild(slotEntry, props, renderer, id) {
  const boundary = slotEntry.component(props)
  const childEl = boundary.props.children[0]
  assert.equal(typeof childEl.type, 'function', 'Component inside Boundary must be a function')
  return renderer.renderComponent(childEl.type, childEl.props, id)
}

describe('#399 WebUI localization & slot translator propagation', () => {
  it('translates VisionCard and VisionSection into Chinese when locale is zh', () => {
    const { renderer, registeredSlots, mockCtx } = setupEnv('zh')
    const rowSlot = registeredSlots.get('plugins.row.config')
    assert.ok(rowSlot, 'plugins.row.config slot must be registered')

    // 1. Summary view under zh
    const summaryResult = renderSlotChild(rowSlot, { view: 'summary', ctx: mockCtx }, renderer, 'VisionCardSummary')
    assert.ok(
      summaryResult.props.children.flat().join('').includes('聊天中的图片将由您在此处选择的视觉模型处理'),
      'Summary subtitle must be in Chinese: ' + summaryResult.props.children
    )

    // 2. Card view under zh
    const cardResult = renderSlotChild(rowSlot, { view: 'card', ctx: mockCtx }, renderer, 'VisionCardZh')
    const headerBtn = cardResult.props.children[0]
    const headTextSpan = headerBtn.props.children[0]
    const titleSpan = headTextSpan.props.children[0]
    assert.equal(titleSpan.props.children.flat().join(''), '视觉 (Vision)', 'Card title must be Chinese')
  })

  it('respects companion slot translator props.t across UI', () => {
    const { renderer, registeredSlots, mockCtx } = setupEnv('en')
    const rowSlot = registeredSlots.get('plugins.row.config')

    const customT = (key) => {
      if (key === 'title') return 'CUSTOM_COMPANION_TITLE'
      if (key === 'subtitle') return 'CUSTOM_COMPANION_SUBTITLE'
      return key
    }

    // 1. Summary view with custom t
    const summaryResult = renderSlotChild(rowSlot, { view: 'summary', t: customT, ctx: mockCtx }, renderer, 'VisionCardCompanionSummary')
    assert.equal(summaryResult.props.children.flat().join(''), 'CUSTOM_COMPANION_SUBTITLE')

    // 2. Card view with custom t
    const cardResult = renderSlotChild(rowSlot, { view: 'card', t: customT, ctx: mockCtx }, renderer, 'VisionCardCompanionCard')
    const headerBtn = cardResult.props.children[0]
    const headTextSpan = headerBtn.props.children[0]
    const titleSpan = headTextSpan.props.children[0]
    assert.equal(titleSpan.props.children.flat().join(''), 'CUSTOM_COMPANION_TITLE')
  })

  it('localizes VisionInputControls mode button and tooltip', () => {
    const { renderer, registeredSlots, mockCtx } = setupEnv('zh')
    const inputSlot = registeredSlots.get('conversation.input.right')
    assert.ok(inputSlot, 'conversation.input.right slot must be registered')

    const controlsResult = renderSlotChild(inputSlot, { ctx: mockCtx }, renderer, 'VisionControlsZh')
    const modeBtn = controlsResult.props.children[0]
    const pdfBtn = controlsResult.props.children[1]

    assert.ok(modeBtn.props.title.includes('视觉: 混合模式'), 'Mode title tooltip must be in Chinese')
    assert.equal(pdfBtn.props.title, '上传并转换 PDF 文档', 'PDF button title tooltip must be in Chinese')
  })
})
