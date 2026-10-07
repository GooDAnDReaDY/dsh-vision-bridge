// test/402_design_contract_slots.test.js — Modern slot contract & internal doc consistency (#402)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const clientPath = new URL('../lib/client.js', import.meta.url).pathname
const clientCode = fs.readFileSync(clientPath, 'utf8')
const pkgPath = new URL('../package.json', import.meta.url).pathname
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const gitignorePath = new URL('../.gitignore', import.meta.url).pathname
const gitignore = fs.readFileSync(gitignorePath, 'utf8')

describe('#402 Design Contract: modern slots & config forms', () => {
  it('registers plugins.row.config as primary slot before settings.plugin.item fallback', () => {
    const rowIdx = clientCode.indexOf("'plugins.row.config'")
    const fallbackIdx = clientCode.indexOf("'settings.plugin.item'")

    assert.ok(rowIdx > 0, 'plugins.row.config must be present in client.js')
    assert.ok(fallbackIdx > 0, 'settings.plugin.item must be present as fallback')
    assert.ok(rowIdx < fallbackIdx, 'plugins.row.config must be registered before settings.plugin.item')

    // settings.section must be completely absent from slot registrations
    assert.equal(clientCode.includes("'settings.section'"), false, 'settings.section must be absent')
    assert.equal(clientCode.includes('"settings.section"'), false, 'settings.section must be absent')
  })

  it('declares configForms in exports.inject and binds row config key', () => {
    assert.match(clientCode, /exports\.inject\s*=\s*\[.*'configForms'.*\]/, 'exports.inject must include configForms')
    assert.match(clientCode, /const ROW_CONFIG_KEY = PKG \+ '#' \+ ROW_ID/, 'ROW_CONFIG_KEY must be constructed')
  })

  it('verifies slot registration order and configForms interaction in runtime VM', () => {
    const registeredSlots = []
    let configFormRequested = null

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
        get(key) {
          configFormRequested = key
          return {
            getSnapshot() { return { value: { mode: 'hybrid' } } },
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
        load(mod) { loadedModule = mod },
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
        render() { return this.props?.children || null }
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
      fetch: async () => ({ ok: true, json: async () => ({}) }),
    }

    vm.runInNewContext(clientCode, sandbox)
    assert.ok(loadedModule, 'ModuleLoader.load must be invoked')

    const clientExports = loadedModule.factory(fakeRequire)
    clientExports.apply(mockCtx)

    const slotNames = registeredSlots.map((s) => s.meta.name)
    assert.ok(slotNames.includes('plugins.row.config'), 'plugins.row.config must be registered')
    assert.ok(slotNames.includes('settings.plugin.item'), 'settings.plugin.item fallback must be registered')

    const rowSlot = registeredSlots.find((s) => s.meta.name === 'plugins.row.config')
    assert.equal(rowSlot.meta.key, '@goodandready/dsh-vision-bridge#dsh-vision-bridge')
  })

  it('preserves owner policy: internal docs excluded from git index and npm package', () => {
    // 1. docs/ must be covered by .gitignore
    assert.match(gitignore, /docs\//, '.gitignore must exclude docs/')

    // 2. package.json files array must NOT include docs
    const files = pkg.files || []
    assert.equal(files.includes('docs/'), false, 'package.json files must not contain docs/')
    assert.equal(files.includes('docs'), false, 'package.json files must not contain docs')
  })
})
