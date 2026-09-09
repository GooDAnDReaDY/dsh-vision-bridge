// Minimal cordis-like mock context so lib/index.js apply() runs without the
// DSH host (#205). Everything is in-memory; no network and no sharp required.
// Effects are executed immediately (so webServer routes and the modality
// bridge register exactly like in production); disposers are ignored.

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

export function testConfig(overrides = {}) {
  return {
    sanitizeImages: true,
    mode: 'hybrid',
    describeStrategy: 'auto',
    escalation: 'simple-only',
    channels: [],
    channelFallback: 'sequential',
    channelOrderMode: 'manual',
    channelTimeoutMs: 30000,
    channelCooldownMs: 60000,
    channelFailureMode: 'placeholder',
    autoLocalOllama: false,
    autoDiscoverOllama: false,
    autoFreeProviders: false,
    includeOAuthProviders: false,
    keysFromEnv: [],
    cacheEnabled: true,
    cacheMaxEntries: 256,
    nativePassthrough: 'prefer',
    evidencePersist: false,
    evidenceDir: '',
    evidenceMaxEntries: 2000,
    allowedImageDirs: [],
    auditLog: 'off',
    maskSecrets: true,
    maskPII: false,
    maskSystemPaths: false,
    focusHint: false,
    taskMode: 'glance',
    maxImageBytes: 20 * 1024 * 1024,
    maxImagePixels: 4000000,
    imageMaxWidth: 1920,
    imageMaxHeight: 1080,
    imageQuality: 80,
    imageFormat: 'auto',
    tileLargeImages: true,
    tileThreshold: 4000000,
    deskew: false,
    enhanceImage: false,
    blurFaces: false,
    stripEXIF: false,
    nsfwFilter: false,
    selfCheckEnabled: true,
    consensusEnabled: false,
    detail: 'auto',
    stream: false,
    timeoutMs: 120000,
    visionProvider: '',
    visionModel: '',
    ...overrides,
  }
}

export function createMockCtx(options = {}) {
  const config = testConfig(options.config)
  const toolDefs = new Map()
  const toolNames = []
  const routes = new Map()
  const listeners = new Map()
  const effects = []
  const streams = []
  let attSeq = 0

  const settingsScope = {
    get: () => ({}),
    update: async () => {},
    unset: async () => {},
  }

  const ctx = {
    config,
    toolDefs,
    toolNames,
    routes,
    listeners,
    effects,
    streams,
    llm: {
      listProviders: () => [{ provider: 'prov' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: 'm1', name: 'mock-vision', inputModalities: ['text', 'image'] }],
      resolveModelInfo: async () => ({ inputModalities: ['text'] }),
      stream: (opts) => {
        streams.push(opts)
        return (async function* () {
          yield { type: 'text-delta', text: options.streamText || 'MOCK DESCRIPTION' }
        })()
      },
    },
    attachments: {
      saveImage: async (o) => ({ attachmentId: 'att-' + ++attSeq, mediaType: o.mediaType || 'image/png', name: o.name || 'mock' }),
      readImage: async () => ({
        data: options.imageBytes ? Buffer.from(options.imageBytes) : TINY_PNG,
        ref: { mediaType: 'image/png' },
      }),
    },
    get: () => undefined,
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
    effect: (fn, label) => {
      effects.push(label || 'unlabeled')
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : undefined
    },
    inject: (_names, cb) => cb(ctx),
    tools: {
      register: (def) => {
        toolNames.push(def.name)
        toolDefs.set(def.name, def)
      },
    },
    webServer: {
      register: (def) => {
        routes.set(def.path, def)
        return def
      },
    },
    settings: {
      register: (_ns, _schema, _opts) => settingsScope,
    },
  }
  return ctx
}

/** apply() + drain one image through the llm/stream backstop, exactly like
 *  production does at the agent boundary, so attachment ids get indexed. */
export async function setupWithAttachment(options = {}) {
  const mod = await import('../lib/index.js')
  const ctx = createMockCtx(options)
  mod.apply(ctx, ctx.config)
  const backstop = ctx.listeners.get('llm/stream')[0]
  const gen = backstop(
    { messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }] }] },
    async function* () {},
  )
  for await (const chunk of gen) { void chunk }
  return { mod, ctx }
}

export function fakeRes() {
  return {
    status: 0,
    body: null,
    headers: null,
    writeHead(code, headers) { this.status = code; this.headers = headers || null },
    end(body) { this.body = body },
  }
}

/** req double that answers readBody()-style on('data'/'end') handlers. */
export function fakeReq({ method = 'GET', headers = {}, body = '', url = '/dsh-vision-bridge/x' } = {}) {
  return {
    method,
    headers,
    url,
    on(event, cb) {
      if (event === 'data' && body) cb(body)
      if (event === 'end') cb()
    },
  }
}
