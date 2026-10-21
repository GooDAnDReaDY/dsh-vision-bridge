import z from '@deepseek-ai/schemastery'

export const name = '@goodandready/dsh-vision-bridge'
export const inject = ['tools', 'llm', 'attachments', 'fs', 'webServer', 'settings', 'skills']

// Unwrap Volatile boxes before any caller reads a value. A volatile field holds a box
// rather than its value, and the Loader mutates those boxes in place.
export function wrapConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') return rawConfig || {}
  return new Proxy(rawConfig, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver)
      return plainConfig(val)
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver)
    },
    has(target, prop) {
      return Reflect.has(target, prop)
    },
    ownKeys(target) {
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
  })
}

export function plainConfig(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(plainConfig)
  if (typeof value.get === 'function') return plainConfig(value.get())
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof RegExp || value instanceof Date) return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainConfig(v)]))
}

export const Config = z.object({
  // Empty => auto-pick the first vision-capable model found in the LLM catalog.
  visionProvider: z
    .string()
    .volatile()
    .description('Provider of the vision model that answers describe_image. Empty = auto-detect.')
    .default(''),
  visionModel: z
    .string()
    .volatile()
    .description('Model id of the vision model. Empty = auto-detect.')
    .default(''),
  sanitizeImages: z
    .boolean()
    .volatile()
    .description('Rewrite image blocks to text markers for text-only models so turns never fail.')
    .default(true),
  // 'hybrid' preserves the legacy behavior (auto-rewrite + tools available).
  // 'llm' = same rewrite but explicitly user-chosen. 'tools' = never auto-rewrite;
  // the model has to call describe_image itself, otherwise the adapter fails.
  mode: z
    .union([z.const('hybrid'), z.const('llm'), z.const('tools')])
    .volatile()
    .description('Bridge mode: hybrid (default, auto-rewrite + tools), llm (auto-rewrite only), tools (no auto-rewrite, model must call describe_image).')
    .default('hybrid'),
  // 'auto' = call the vision LLM (current behavior). 'ocr-local' / 'cache-only' are
  // hints reserved for future local-OCR fallback; until then they behave like 'auto'.
  ocrLang: z
    .string()
    .volatile()
    .description('Default language for local OCR engine (e.g. eng, chi_sim, rus). Default canonical is eng.')
    .default('eng'),
  describeStrategy: z
    .union([z.const('auto'), z.const('llm'), z.const('ocr-local'), z.const('cache-only')])
    .volatile()
    .description('How describe_image and the auto-rewrite resolve a description. auto/llm use the vision LLM today; ocr-local/cache-only are reserved.')
    .default('auto'),
  // 'simple-only' = one pass. 'auto-escalate' = ask the vision model to self-rate
  // complexity; if complex, do a second deeper pass before substituting (idea from
  // 54xkeee/dsh-vision-web).
  escalation: z
    .union([z.const('simple-only'), z.const('auto-escalate')])
    .volatile()
    .description('Escalation policy for the auto-rewrite. simple-only = one pass; auto-escalate = second pass on complex images.')
    .default('simple-only'),
  // Multi-channel vision endpoint (Issue #2). Empty = legacy auto-pick from
  // the DSH LLM catalog (one channel = {type:'dsh-catalog'}).
  channels: z
    .array(z.any())
    .volatile()
    .description('Vision endpoints tried in order. Empty array = legacy auto-pick. Supported types: dsh-catalog, openai-compatible, ollama, custom.')
    .default([]),
  channelFallback: z
    .union([z.const('sequential'), z.const('parallel-race')])
    .volatile()
    .description('How channels are tried. sequential = one by one until one succeeds (default). parallel-race = all at once, first success wins.')
    .default('sequential'),
  channelOrderMode: z
    .union([z.const('manual'), z.const('auto-latency')])
    .volatile()
    .description('How channels are ordered. manual = user-defined order (default). auto-latency = sort by average latency, fastest first.')
    .default('manual'),
  channelTimeoutMs: z
    .number()
    .volatile()
    .description('Per-channel HTTP timeout in milliseconds.')
    .default(30000),
  channelCooldownMs: z
    .number()
    .volatile()
    .description('Skip a failing channel for this long after a 4xx/timeout. 0 disables cooldown.')
    .default(60000),
  channelFailureMode: z
    .union([z.const('placeholder'), z.const('error')])
    .volatile()
    .description('What to do when ALL channels fail. placeholder (default) inserts "[image description unavailable]" and lets the chat continue; error throws.')
    .default('placeholder'),
  autoLocalOllama: z
    .boolean()
    .volatile()
    .description('On startup, probe http://localhost:11434/v1 and prepend an ollama channel if reachable.')
    .default(true),
  keysFromEnv: z
    .array(z.string())
    .volatile()
    .description('Env-var names to look up when a channel has no apiKey. Order matters: first match wins.')
    .default(['VISION_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY', 'ZHIPUAI_API_KEY']),
  // #202: server-side fetches of model-supplied URLs refuse private/loopback/
  // link-local hosts. Operators who need an internal endpoint name it here
  // (exact hostname match); an empty list means "any public host".
  allowedUrlHosts: z
    .array(z.string())
    .volatile()
    .description('If non-empty, ONLY http(s) URLs on these exact hosts may be fetched server-side — this is also the way to deliberately re-allow an internal endpoint. Empty = any public host; private/loopback/link-local hosts are always refused otherwise.')
    .default([]),
  // Per-image description cache (Issue #3). LRU with composite key.
  cacheEnabled: z
    .boolean()
    .volatile()
    .description('Enable in-memory cache of descriptions keyed by image bytes + prompt + model + mode.')
    .default(true),
  cacheMaxEntries: z
    .number()
    .volatile()
    .description('Maximum number of cached descriptions before LRU eviction.')
    .default(256),
  // Block 7 (0.2.12): native passthrough control.
  // #242: hide the compensation tools from agents whose chat model already
  // supports images natively — they exist only to give a text-only model sight.
  hideRedundantTools: z
    .boolean()
    .volatile()
    .description('When the active chat model supports images natively, hide the bridge/compensation tools from that agent and keep only the extra instruments (media, documents, workflow).')
    .default(true),
  nativePassthrough: z
    .union([z.const('prefer'), z.const('always'), z.const('never')])
    .volatile()
    .description('prefer (default): bridge only for text-only models; always: never bridge; never: always bridge even for vision models.')
    .default('prefer'),
  // Block 4 (0.2.9): persist evidence across restarts.
  evidencePersist: z
    .boolean()
    .volatile()
    .description('Persist descriptions to disk so later sessions reuse them without re-calling the vision model.')
    .default(false),
  evidenceDir: z
    .string()
    .volatile()
    .description('Directory for vision-evidence.json. Empty = plugin data dir (DSH-provided) or cwd fallback.')
    .default(''),
  evidenceMaxEntries: z
    .number()
    .volatile()
    .description('Maximum persisted entries before oldest-ts eviction.')
    .default(2000),
  // Block 8 (0.2.13): privacy boundary.
  allowedImageDirs: z
    .array(z.string())
    .volatile()
    .description('If non-empty, only allow image paths under these dirs; others are rejected.')
    .default([]),
  auditLog: z
    .union([z.const('off'), z.const('errors'), z.const('all')])
    .volatile()
    .description('off: no log; errors: log failures; all: log every vision call.')
    .default('off'),
  maskSecrets: z
    .boolean()
    .volatile()
    .description('Mask API keys in error messages.')
    .default(true),
  // Block 0.3.9 (#65): task-aware vision prompts.
  focusHint: z
    .boolean()
    .volatile()
    .description('Pass the latest user message as a focus hint to the vision model, so the description emphasises what the user asked about.')
    .default(true),
  taskMode: z
    .union([z.const('glance'), z.const('ocr'), z.const('region'), z.const('compare')])
    .volatile()
    .description('Default framing for the auto-rewrite prompt. glance = general; ocr = transcribe; region = spatial layout; compare = differences across images.')
    .default('glance'),
  maxImageBytes: z
    .number()
    .volatile()
    .description('Upper bound in bytes for a single image sent to the vision model.')
    .default(20 * 1024 * 1024),
  // #228: hard cap for PDF uploads handed to /upload-pdf.
  // #241: how many images one attach call may publish (PDF pages, video
  // frames, files). Hard ceiling 32 in lib/tools/attach.js.
  attachMaxItems: z
    .number()
    .volatile()
    .description('Maximum attachments published by one vision_attach_* call (PDF pages, video frames, images).')
    .default(8),
  maxPdfBytes: z
    .number()
    .volatile()
    .description('Upper bound in bytes for a PDF uploaded through /upload-pdf. Oversized payloads are rejected with 413 before buffering.')
    .default(20 * 1024 * 1024),
  imageMaxWidth: z
    .number()
    .volatile()
    .description('Maximum image width in pixels. Images larger than this are resized before sending to the vision model.')
    .default(1920),
  imageMaxHeight: z
    .number()
    .volatile()
    .description('Maximum image height in pixels. Images larger than this are resized before sending to the vision model.')
    .default(1080),
  imageQuality: z
    .number()
    .volatile()
    .description('Image compression quality (1-100) for WebP/JPEG output.')
    .default(80),
  imageFormat: z
    .union([z.const('auto'), z.const('webp'), z.const('jpeg'), z.const('avif')])
    .volatile()
    .description('Output format for compressed images. auto = WebP if sharp available, else JPEG.')
    .default('auto'),
  deskew: z
    .boolean()
    .volatile()
    .description('Automatically detect and correct image rotation/perspective before sending.')
    .default(false),
  enhanceImage: z
    .boolean()
    .volatile()
    .description('Apply adaptive contrast (CLAHE) and whiteboard cleaning before sending.')
    .default(false),
  selfCheckEnabled: z.boolean().volatile().default(true),
  consensusEnabled: z.boolean().volatile().default(false),
  maskPII: z
    .boolean()
    .volatile()
    .description('Mask PII (emails, phones, names) in prompts before sending to vision model.')
    .default(false),
  maskSystemPaths: z
    .boolean()
    .volatile()
    .description('Mask system paths and IP addresses in vision model responses.')
    .default(false),
  stripEXIF: z
    .boolean()
    .volatile()
    .description('Strip EXIF metadata from images before sending to vision model.')
    .default(false),
  includeOAuthProviders: z
    .boolean()
    .volatile()
    .description('If true and dsh-subscription plugin is installed, include OAuth vision providers as additional channels.')
    .default(true),
  autoDiscoverOllama: z
    .boolean()
    .volatile()
    .description('Auto-discover all vision models in local Ollama and add as channels.')
    .default(true),
  autoFreeProviders: z
    .boolean()
    .volatile()
    .description('Auto-add free vision providers when their API key is set in environment.')
    .default(true),
  // #91: uniform pixel-count guard before the vision call. Without a native
  // image lib we reject oversized images with a clear error instead of silently
  // sending multi-MP payloads that providers reject. Upgrade path: if sharp is
  // installed, downscale to this limit in one place here.
  maxImagePixels: z
    .number()
    .volatile()
    .description('Upper bound in pixels (width*height) for a single image. 0 disables the guard. Default 4MP.')
    .default(4_000_000),
  // #96: per-call resolution hint for vision tools (token economy on large images).
  detail: z
    .union([z.const('auto'), z.const('low'), z.const('high')])
    .volatile()
    .description('Resolution hint passed to providers that support it. auto = let the provider decide; low = fewer tokens; high = maximum fidelity.')
    .default('auto'),
  // #106: stream vision responses token-by-token for faster first-token latency.
  stream: z
    .boolean()
    .volatile()
    .description('Stream openai-compatible responses (SSE) for faster first token. Falls back to non-stream automatically.')
    .default(false),
  timeoutMs: z
    .number()
    .volatile()
    .description('Timeout for a describe_image call in milliseconds.')
    .default(120000),
})

/** True when the bridge is allowed to substitute image blocks for the given mode. */
export function sanitizeAllowed(config) {
  return config.sanitizeImages !== false && config.mode !== 'tools'
}

/** Whether to let a vision-capable model see the image natively instead of bridging. */
export function shouldBridgeForModel(config, supportsImages) {
  const pref = config.nativePassthrough || 'prefer'
  if (pref === 'never') return true
  if (pref === 'always') return false
  return !supportsImages // prefer: bridge only when text-only
}

/** True when `info` (from ctx.llm) explicitly declares image input. */
export function acceptsImages(info) {
  if (info && Array.isArray(info._nativeInputModalities)) {
    return info._nativeInputModalities.includes('image')
  }
  return Array.isArray(info && info.inputModalities) && info.inputModalities.includes('image')
}

/** Whether any block in `content` is an image. */
export function blocksHaveImage(content) {
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    if (!block || typeof block !== 'object') return false
    if (block.type === 'image') return true
    return Array.isArray(block.content) && blocksHaveImage(block.content)
  })
}

