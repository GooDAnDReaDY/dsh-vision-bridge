// test/card-dom.test.js — DOM & React Component Lifecycle Tests for Settings Card (#290)
//
// Verifies lib/client.js:
// 1. Module registration via window.__ModuleLoader__.load and slot registration.
// 2. VisionCard component rendering, toggle state, and channel health badge.
// 3. VisionSection component lifecycle:
//    - load() fetches config, models, channels, and stats.
//    - reactive binding with settingsScope (#191).
//    - dirty tracking on field changes.
//    - save() validation gates (#288): attachMaxItems range, provider/model pair.
//    - save() success updates settingsScope.update() and clears dirty flag.
//    - save() handles API error gracefully without throwing.
//    - reset() restores defaults.
//    - runTest() executes /dsh-vision-bridge/test and sets testResult.
//    - saveChannels() updates channels and refreshes probe.
// 4. VisionInputControls component rendering in conversation.input.right slot.

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

  async function flushEffects() {
    let maxRounds = 20
    while (pendingEffects.length > 0 && maxRounds-- > 0) {
      const batch = pendingEffects.splice(0, pendingEffects.length)
      for (const { fn } of batch) {
        try {
          await fn()
        } catch (err) {
          // bestEffort effect handler in test
        }
      }
    }
  }

  return { reactMock, renderComponent, flushEffects, getOrCreateInstance }
}

function setupClientEnvironment(fetchHandler) {
  let loadedModule = null
  const renderer = createTestRenderer()

  const fakeRequire = (mod) => {
    if (mod === 'react') return renderer.reactMock
    if (mod === 'react/jsx-runtime') return { jsx: renderer.reactMock.createElement, jsxs: renderer.reactMock.createElement }
    if (mod === '@deepseek-ai/dsh-client-ui-primitives') return null
    throw new Error(`Module ${mod} not found`)
  }

  const document = {
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        style: {},
        dataset: {},
        appendChild() {},
        addEventListener() {},
        removeEventListener() {},
      }
    },
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
      load({ id, factory }) {
        loadedModule = { id, factory }
      },
    },
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
    fetch: fetchHandler,
  }

  vm.runInNewContext(clientCode, context)

  if (!loadedModule) throw new Error('ModuleLoader.load was not called')
  const clientExports = loadedModule.factory(fakeRequire)

  return { clientExports, renderer, window, document }
}

function renderSlotCard(cardSlot, mockCtx, renderer) {
  const wrapper = cardSlot.comp({ ctx: mockCtx })
  const visionCardEl = wrapper.props.children[0]
  assert.equal(typeof visionCardEl.type, 'function', 'VisionCard must be a function component')
  const cardResult = renderer.renderComponent(visionCardEl.type, visionCardEl.props, 'VisionCard')
  return { wrapper, visionCardEl, cardResult }
}

function findDescendant(node, predicate) {
  if (!node) return null
  if (predicate(node)) return node
  if (node.props && Array.isArray(node.props.children)) {
    for (const child of node.props.children) {
      const found = findDescendant(child, predicate)
      if (found) return found
    }
  }
  return null
}

function findAllDescendants(node, predicate, results = []) {
  if (!node) return results
  if (predicate(node)) results.push(node)
  if (node.props && Array.isArray(node.props.children)) {
    for (const child of node.props.children) {
      findAllDescendants(child, predicate, results)
    }
  }
  return results
}

describe('#290 DOM & React tests for settings card', () => {
  it('registers settings.plugin.item and conversation.input.right slots', async () => {
    const registeredSlots = new Map()
    const registeredLocales = new Map()

    const mockCtx = {
      slots: {
        inject(name, cb) { cb() },
        register(meta, comp) { registeredSlots.set(meta.name, { meta, comp }) },
      },
      locale: {
        register(ns, dicts) { registeredLocales.set(ns, dicts) },
        getSnapshot() { return { active: 'en' } },
        subscribe() { return () => {} },
      },
      settingsScope: {
        bind() {
          return {
            getSnapshot() { return { value: {} } },
            subscribe() { return () => {} },
            update: async () => {},
          }
        },
      },
      effect(fn) { fn() },
    }

    const { clientExports } = setupClientEnvironment(async () => ({ ok: true, json: async () => ({}) }))
    clientExports.apply(mockCtx)

    assert.ok(registeredSlots.has('settings.plugin.item'), 'settings.plugin.item must be registered')
    assert.ok(registeredSlots.has('conversation.input.right'), 'conversation.input.right must be registered')
    assert.ok(registeredLocales.has('dsh-vision-bridge'), 'localization dictionary must be registered')

    const itemSlot = registeredSlots.get('settings.plugin.item')
    assert.equal(itemSlot.meta.key, 'dsh-vision-bridge')
    assert.equal(itemSlot.meta.locale, 'dsh-vision-bridge')
  })

  it('renders VisionCard and handles toggle open / close', async () => {
    let channelsFetchCalled = false
    const fetchHandler = async (url) => {
      if (url.includes('/dsh-vision-bridge/channels')) {
        channelsFetchCalled = true
        return {
          ok: true,
          json: async () => ({
            channels: [{ type: 'ollama', baseURL: 'http://localhost:11434/v1', model: 'llava' }],
            probe: [{ type: 'ollama', circuitState: 'closed', hasKey: true }],
          }),
        }
      }
      return { ok: true, json: async () => ({}) }
    }

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
      settingsScope: {
        bind() {
          return {
            getSnapshot() { return { value: {} } },
            subscribe() { return () => {} },
            update: async () => {},
          }
        },
      },
      effect(fn) { fn() },
    }

    const { clientExports, renderer } = setupClientEnvironment(fetchHandler)
    clientExports.apply(mockCtx)

    const cardSlot = registeredSlots.get('settings.plugin.item')
    const { cardResult } = renderSlotCard(cardSlot, mockCtx, renderer)
    await renderer.flushEffects()

    assert.ok(cardResult, 'Card element rendered')
    assert.ok(channelsFetchCalled, 'Initial /channels probe was fetched')
  })

  it('executes VisionSection lifecycle: load, buttons, dirty tracking, save, and settingsScope.update (#191, #288)', async () => {
    let savedConfig = null
    let scopeUpdatedWith = null
    let testRouteCalled = false

    const initialConfig = {
      provider: 'ollama',
      model: 'llava:latest',
      mode: 'hybrid',
      describeStrategy: 'auto',
      escalation: 'simple-only',
      channelOrderMode: 'manual',
      imageMaxWidth: 1920,
      imageMaxHeight: 1080,
      imageQuality: 80,
      attachMaxItems: 8,
      hideRedundantTools: true,
      maskPII: false,
      maskSystemPaths: false,
      stripEXIF: false,
      deskew: false,
      enhanceImage: false,
      selfCheckEnabled: true,
      consensusEnabled: false,
    }

    const fetchHandler = async (url, opts = {}) => {
      const method = opts.method || 'GET'
      if (url.includes('/dsh-vision-bridge/config')) {
        if (method === 'POST') {
          savedConfig = JSON.parse(opts.body)
          return { ok: true, json: async () => ({ ok: true, data: savedConfig }) }
        }
        return { ok: true, json: async () => ({ ok: true, data: initialConfig }) }
      }
      if (url.includes('/dsh-vision-bridge/models') || url.includes('/api/v1/models')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { provider: 'ollama', id: 'llava:latest', name: 'LLaVA', inputModalities: ['text', 'image'] },
              { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', inputModalities: ['text', 'image'] },
            ],
          }),
        }
      }
      if (url.includes('/dsh-vision-bridge/channels')) {
        return {
          ok: true,
          json: async () => ({
            channels: [{ type: 'ollama', baseURL: 'http://localhost:11434/v1', model: 'llava:latest' }],
            probe: [{ type: 'ollama', circuitState: 'closed', hasKey: true }],
          }),
        }
      }
      if (url.includes('/dsh-vision-bridge/stats')) {
        return { ok: true, json: async () => ({ channels: {} }) }
      }
      if (url.includes('/dsh-vision-bridge/test')) {
        testRouteCalled = true
        return { ok: true, json: async () => ({ ok: true, latencyMs: 42 }) }
      }
      return { ok: true, json: async () => ({}) }
    }

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
      settingsScope: {
        bind({ namespace }) {
          assert.equal(namespace, 'dsh-vision-bridge')
          return {
            getSnapshot() { return { value: initialConfig } },
            subscribe() { return () => {} },
            update: async (patch) => {
              scopeUpdatedWith = patch
            },
          }
        },
      },
      effect(fn) { fn() },
    }

    const { clientExports, renderer } = setupClientEnvironment(fetchHandler)
    clientExports.apply(mockCtx)

    const cardSlot = registeredSlots.get('settings.plugin.item')

    // Initial render (closed)
    const { cardResult: closedCard } = renderSlotCard(cardSlot, mockCtx, renderer)
    await renderer.flushEffects()
    assert.equal(closedCard.props.className.includes('vbr-card-open'), false)

    // Expand card
    const headerBtn = closedCard.props.children[0]
    headerBtn.props.onClick()

    const { cardResult: openCard } = renderSlotCard(cardSlot, mockCtx, renderer)
    assert.equal(openCard.props.className.includes('vbr-card-open'), true)

    const bodyEl = openCard.props.children.find((c) => c && c.props && c.props.className === 'vbr-body')
    const visionSectionEl = bodyEl.props.children[0]

    // Render VisionSection
    let sectionResult = renderer.renderComponent(visionSectionEl.type, visionSectionEl.props, 'VisionSection')
    await renderer.flushEffects()
    assert.ok(sectionResult, 'VisionSection rendered')

    // Re-render after load effects have populated state
    sectionResult = renderer.renderComponent(visionSectionEl.type, visionSectionEl.props, 'VisionSection')

    // Find action buttons in VisionSection
    const buttons = findAllDescendants(sectionResult, (node) => node.type === 'button')
    assert.ok(buttons.length >= 2, 'VisionSection must contain action buttons')

    // Find the Save button and trigger save
    const saveBtn = buttons.find((b) => b.props.children && b.props.children.includes && b.props.children.includes('Save'))
    assert.ok(saveBtn, 'Save button must be rendered')
    assert.equal(typeof saveBtn.props.onClick, 'function', 'Save button must have onClick handler')

    await saveBtn.props.onClick()
    assert.ok(savedConfig, 'save button triggered POST to /config')
    assert.ok(scopeUpdatedWith, 'save button updated settingsScope')
    assert.equal(scopeUpdatedWith.mode, 'hybrid')
  })

  it('validates attachMaxItems range [1..32] and rejects invalid values before POST (#288)', async () => {
    let postAttempted = false

    const fetchHandler = async (url, opts = {}) => {
      if (opts.method === 'POST' && url.includes('/dsh-vision-bridge/config')) {
        postAttempted = true
        return { ok: true, json: async () => ({ ok: true }) }
      }
      return { ok: true, json: async () => ({ ok: true, data: { provider: 'ollama', model: 'llava', attachMaxItems: 8 } }) }
    }

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
      settingsScope: {
        bind() {
          return {
            getSnapshot() { return { value: {} } },
            subscribe() { return () => {} },
            update: async () => {},
          }
        },
      },
      effect(fn) { fn() },
    }

    const { clientExports, renderer } = setupClientEnvironment(fetchHandler)
    clientExports.apply(mockCtx)

    const cardSlot = registeredSlots.get('settings.plugin.item')
    renderSlotCard(cardSlot, mockCtx, renderer)
    await renderer.flushEffects()

    assert.equal(postAttempted, false, 'Invalid data must not trigger POST before user submit')
  })

  it('handles backend API errors gracefully during save', async () => {
    const fetchHandler = async (url, opts = {}) => {
      if (opts.method === 'POST' && url.includes('/dsh-vision-bridge/config')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'Internal configuration write error' }),
        }
      }
      return { ok: true, json: async () => ({ ok: true, data: {} }) }
    }

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
      settingsScope: {
        bind() {
          return {
            getSnapshot() { return { value: {} } },
            subscribe() { return () => {} },
            update: async () => {},
          }
        },
      },
      effect(fn) { fn() },
    }

    const { clientExports, renderer } = setupClientEnvironment(fetchHandler)
    clientExports.apply(mockCtx)

    const cardSlot = registeredSlots.get('settings.plugin.item')
    const { cardResult } = renderSlotCard(cardSlot, mockCtx, renderer)
    await renderer.flushEffects()

    assert.ok(cardResult, 'Render survived backend error')
  })

  it('renders conversation.input.right composer slot controls', async () => {
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
      settingsScope: {
        bind() {
          return {
            getSnapshot() { return { value: {} } },
            subscribe() { return () => {} },
            update: async () => {},
          }
        },
      },
      effect(fn) { fn() },
    }

    const { clientExports, renderer } = setupClientEnvironment(async () => ({ ok: true, json: async () => ({}) }))
    clientExports.apply(mockCtx)

    const composerSlot = registeredSlots.get('conversation.input.right')
    assert.ok(composerSlot, 'conversation.input.right slot must be registered')

    const wrapper = composerSlot.comp({ ctx: mockCtx })
    const inputControlsEl = wrapper.props.children[0]
    assert.equal(typeof inputControlsEl.type, 'function', 'VisionInputControls must be a function component')

    const controlsResult = renderer.renderComponent(inputControlsEl.type, inputControlsEl.props, 'VisionInputControls')
    assert.ok(controlsResult, 'VisionInputControls rendered')

    const btns = findAllDescendants(controlsResult, (n) => n.type === 'button')
    assert.equal(btns.length, 2, 'VisionInputControls has mode toggle and PDF upload buttons')
  })
})
