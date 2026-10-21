import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMockCtx, validateToolOutput } from './harness.js'
import { apply } from '../lib/index.js'

describe('Issue #401: Settings contract and multi-line DSH compatibility', () => {
  it('initializes cleanly on modern DSH 0.2 line without retired settings.register', async () => {
    const ctx = createMockCtx({ dshLine: '0.2' })
    assert.equal(typeof ctx.settings.register, 'undefined', 'Modern DSH 0.2 line must not have retired settings.register')
    assert.equal(typeof ctx.settings.scope, 'function', 'Modern DSH 0.2 line must have settings.scope')

    apply(ctx, ctx.config)

    assert.ok(ctx.toolNames.length > 0, 'Tools must be registered on DSH 0.2 line')
    assert.ok(ctx.routes.size > 0, 'Routes must be registered on DSH 0.2 line')
  })

  it('initializes cleanly on legacy DSH 0.1 line with settings.register', async () => {
    const ctx = createMockCtx({ dshLine: '0.1' })
    assert.equal(typeof ctx.settings.register, 'function', 'Legacy DSH 0.1 line must provide settings.register')

    apply(ctx, ctx.config)

    assert.ok(ctx.toolNames.length > 0, 'Tools must be registered on DSH 0.1 line')
    assert.ok(ctx.routes.size > 0, 'Routes must be registered on DSH 0.1 line')
  })

  it('updates configuration via settings/document-updated event on DSH 0.2 line', async () => {
    const ctx = createMockCtx({ dshLine: '0.2', config: { taskMode: 'glance' } })
    apply(ctx, ctx.config)

    assert.equal(ctx.config.taskMode, 'glance')

    const listeners = ctx.listeners.get('settings/document-updated') || []
    assert.ok(listeners.length > 0, 'settings/document-updated listener must be registered')

    // Simulate DSH 0.2 settings document update
    for (const listener of listeners) {
      listener({
        ns: 'dsh-vision-bridge',
        value: { taskMode: 'inspect', maxImagePixels: 8000000 },
      })
    }

    assert.equal(ctx.config.taskMode, 'inspect')
    assert.equal(ctx.config.maxImagePixels, 8000000)
  })

  it('verifies all registered tools have valid strict output schemas', async () => {
    const ctx = createMockCtx({ dshLine: '0.2', config: { consensusEnabled: true, selfCheckEnabled: true } })
    apply(ctx, ctx.config)

    assert.equal(ctx.toolNames.length, 50, 'Expected 50 tools when all features enabled')

    for (const name of ctx.toolNames) {
      const def = ctx.toolDefs.get(name)
      assert.ok(def, `Tool ${name} definition must exist`)
      assert.ok(def.output, `Tool ${name} must declare output`)
      assert.ok(def.output.schema, `Tool ${name} must declare output.schema`)

      const schema = def.output.schema
      assert.equal(schema.type, 'object', `Tool ${name} output.schema.type must be "object"`)
      assert.equal(schema.additionalProperties, false, `Tool ${name} must declare additionalProperties: false`)
      assert.ok(schema.properties && typeof schema.properties === 'object', `Tool ${name} must declare properties`)

      // Test validateToolOutput utility doesn't throw on mock valid object
      const dummyObj = {}
      for (const [k, propSchema] of Object.entries(schema.properties)) {
        if (propSchema.type === 'string') dummyObj[k] = 'test'
        else if (propSchema.type === 'number') dummyObj[k] = 0
        else if (propSchema.type === 'boolean') dummyObj[k] = false
        else if (propSchema.type === 'array') dummyObj[k] = []
        else if (propSchema.type === 'object') dummyObj[k] = {}
      }
      assert.doesNotThrow(() => {
        validateToolOutput(dummyObj, schema, name)
      }, `Schema for tool ${name} must validate against dummy matching object`)

      // Test validateToolOutput rejects undeclared properties
      const badObj = { ...dummyObj, _extraForbiddenField: 123 }
      assert.throws(() => {
        validateToolOutput(badObj, schema, name)
      }, /undeclared property/, `Schema for tool ${name} must reject undeclared property`)
    }
  })
})
