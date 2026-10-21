// test/issue-435-audit-dead-slot-storage.test.js — Regression for Issue #435
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveStorageDir } from '../lib/storage.js'

const clientPath = new URL('../lib/client.js', import.meta.url).pathname
const clientCode = fs.readFileSync(clientPath, 'utf8')

describe('Issue #435: Audit dead client slot retirement & constrained evidence dir', () => {
  it('retired seat settings.plugin.item is not registered in client.js', () => {
    assert.equal(
      clientCode.includes("slots.register({\n                name: 'settings.plugin.item'"),
      false,
      'settings.plugin.item registration must be absent',
    )
    assert.doesNotMatch(
      clientCode,
      /registerSlotWhenReady\(\s*ctx\s*,\s*['"]settings\.plugin\.item['"]/,
      'registerSlotWhenReady must not target settings.plugin.item',
    )
  })

  it('live seats plugins.row.config and plugins.item are registered', () => {
    assert.ok(clientCode.includes("'plugins.row.config'"), 'plugins.row.config must be registered')
    assert.ok(clientCode.includes("'plugins.item'"), 'plugins.item must be registered')
  })

  it('verifies slot registration in runtime VM has only live seats and no settings.plugin.item', () => {
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
        load(mod) { loadedModule = mod },
      },
    }

    const reactMock = {
      useState(v) { return [typeof v === 'function' ? v() : v, () => {}] },
      useEffect() {},
      useMemo(fn) { return fn },
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
    assert.ok(slotNames.includes('plugins.item'), 'plugins.item must be registered')
    assert.equal(slotNames.includes('settings.plugin.item'), false, 'settings.plugin.item must not be registered')
  })

  it('resolveStorageDir safely constrains relative evidenceDir inside baseDir', () => {
    const baseDir = resolve(tmpdir(), 'vbr-storage-test-' + Date.now())
    const ctx = { dataDir: baseDir }

    // Valid relative subpath
    const subpath = 'nested/evidence'
    const resolved = resolveStorageDir(ctx, { evidenceDir: subpath })
    assert.equal(resolved, join(baseDir, 'nested', 'evidence'))
  })

  it('resolveStorageDir throws when relative evidenceDir escapes baseDir via traversal', () => {
    const baseDir = resolve(tmpdir(), 'vbr-storage-escape-' + Date.now())
    const ctx = { dataDir: baseDir }

    assert.throws(() => {
      resolveStorageDir(ctx, { evidenceDir: '../../escaped-evidence' })
    }, /Path escapes directory/)
  })

  it('resolveStorageDir returns baseDir when evidenceDir is empty or not provided', () => {
    const baseDir = resolve(tmpdir(), 'vbr-storage-default-' + Date.now())
    const ctx = { dataDir: baseDir }

    assert.equal(resolveStorageDir(ctx, {}), baseDir)
    assert.equal(resolveStorageDir(ctx, { evidenceDir: '' }), baseDir)
    assert.equal(resolveStorageDir(ctx, { evidenceDir: '   ' }), baseDir)
  })
})
