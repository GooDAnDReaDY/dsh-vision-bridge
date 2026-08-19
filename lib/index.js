// dsh-vision-bridge — host half.
//
// A self-owned vision bridge for text-only DeepSeek conversations:
//  1. At the agent boundary (agent/pre-step) it replaces every image block in
//     the MODEL's request with a text marker pointing at `describe_image`, so
//     an image content block never reaches a text-only provider (which would
//     otherwise fail the whole turn with UNSUPPORTED_CONTENT). The session log
//     keeps the original image, so the Web UI still shows it.
//  2. It registers a `describe_image` tool that sends the image to a vision
//     model of the DEPLOYMENT'S choosing (auto-picked from the LLM catalog, or
//     set explicitly via the Web settings card) and returns its answer to the
//     text model.
//
// Nothing is delegated to third parties: both the rewrite and the vision call
// run here, using the harness `llm` service and the configured vision model.

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-vision-bridge'
export const inject = ['tools', 'llm', 'attachments', 'fs', 'webServer', 'settings']

export const Config = z.object({
  // Empty => auto-pick the first vision-capable model found in the LLM catalog.
  visionProvider: z
    .string()
    .description('Provider of the vision model that answers describe_image. Empty = auto-detect.')
    .default(''),
  visionModel: z
    .string()
    .description('Model id of the vision model. Empty = auto-detect.')
    .default(''),
  sanitizeImages: z
    .boolean()
    .description('Rewrite image blocks to text markers for text-only models so turns never fail.')
    .default(true),
  maxImageBytes: z
    .number()
    .description('Upper bound in bytes for a single image sent to the vision model.')
    .default(20 * 1024 * 1024),
  timeoutMs: z
    .number()
    .description('Timeout for a describe_image call in milliseconds.')
    .default(120000),
})

/** True when `info` (from ctx.llm) explicitly declares image input. */
export function acceptsImages(info) {
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

/**
 * Recursively rewrite image blocks anywhere in a content tree (including
 * inside tool-result blocks and top-level tool results), and collect every
 * attachment reference found so describe_image can read them by id.
 */
export async function rewriteImagesDeep(content, replace) {
  const attachments = []
  const walk = async (blocks) => {
    if (!Array.isArray(blocks)) return { content: blocks, changed: false }
    let changed = false
    const next = []
    for (const block of blocks) {
      if (block && block.type === 'image') {
        if (block.attachment) attachments.push(block.attachment)
        changed = true
        // replace may be sync or async; await the (possibly already-resolved) value.
        const out = await (async () => Promise.resolve(replace(block)))()
        if (out !== undefined && out !== null) {
          if (Array.isArray(out)) next.push(...out)
          else next.push(out)
        }
        continue
      }
      if (block && Array.isArray(block.content)) {
        const nested = await walk(block.content)
        if (nested.changed) {
          changed = true
          next.push({ ...block, content: nested.content })
          continue
        }
      }
      next.push(block)
    }
    return { content: changed ? next : blocks, changed }
  }
  const result = await walk(content)
  return { content: result.content, changed: result.changed, attachments }
}

/** Marks a request this plugin re-dispatched, so the interceptor does not recurse. */
const VISION_PASS = Symbol.for('dsh-vision-bridge/pass')

export function apply(ctx, config) {
  // attachmentId -> full ref, recorded from image blocks seen at the agent
  // boundary so describe_image can read them by id without session plumbing.
  const attachmentById = new Map()
  // contentHash -> description, so repeated questions about the same image
  // reuse a cached answer instead of re-spending a vision-model call, and so
  // later text turns substitute a real description instead of a bare marker.
  const descriptionByHash = new Map()
  // attachmentId -> description, for inline substitution in later text turns.
  const descriptionByAttachmentId = new Map()

  const visionSelection = async () => {
    const provider = (config.visionProvider || '').trim()
    const model = (config.visionModel || '').trim()
    if (provider && model) {
      let info
      try {
        info = await ctx.llm.resolveModelInfo(provider, model)
      } catch {
        info = undefined
      }
      // Explicitly configured but not vision-capable / not found: refuse loudly.
      if (!(info && acceptsImages(info))) {
        throw new Error(
          `dsh-vision-bridge: модель "${provider}/${model}" не объявлена как принимающая изображения (input: ${info && info.inputModalities ? info.inputModalities.join(',') : 'unknown'}). Укажите vision-модель в настройках плагина.`,
        )
      }
      return { provider, model }
    }
    // Auto-detect the first vision-capable model in the catalog.
    const providers = ctx.llm.listProviders().map((p) => p.id)
    if (providers.length > 0) {
      for (const prov of providers) {
        try {
          const models = await ctx.llm.listModels(prov)
          for (const m of models || []) {
            if (acceptsImages(m)) return { provider: prov, model: m.id }
          }
        } catch {
          // try the next provider
        }
      }
    }
    throw new Error(
      'dsh-vision-bridge: не найдено ни одной vision-модели в каталоге LLM. Добавьте vision-модель (input: [text, image]) в Настройки → Модели, либо укажите visionProvider/visionModel в настройках плагина.',
    )
  }

  // Prefer a stable resolution but watch for topologies that change at boot
  // (adapters register asynchronously). Re-resolve per call is safest.
  //
  // Send one image's bytes to the chosen vision model and return the
  // description. Cache by content-hash (and by attachmentId) so repeated
  // questions about the same image (or the same image appearing in many
  // later turns) reuse the previous answer.
  const callVisionModelWithBytes = async (bytes, contentType, question, opts) => {
    const { provider, model } = await visionSelection()
    const hash = contentHash(bytes)
    const cached = descriptionByHash.get(hash)
    if (cached !== undefined) return { description: cached, provider, model, cached: true }
    // The adapter resolves an image block through attachments.readImage(ref),
    // and the store only accepts its own `sha256:<hex>` ids. A fabricated ref
    // makes readImage throw INVALID_ATTACHMENT_REF inside the stream, which
    // collectText silently swallows — so store the bytes and pass the real ref.
    const savedRef = await ctx.attachments.saveImage({
      data: bytes,
      mediaType: contentType || sniffMediaType(bytes) || 'image/png',
      name: 'vision-input',
    })
    const blocks = [
      { type: 'image', attachment: savedRef },
      { type: 'text', text: question },
    ]
    const chunks = ctx.llm.stream({
      ...(opts && opts.signal ? { signal: opts.signal } : {}),
      provider,
      model,
      messages: [{ role: 'user', content: blocks }],
      ...(config.timeoutMs > 0 ? { maxTokens: 1024 } : {}),
    })
    const text = await collectText(chunks)
    if (text) descriptionByHash.set(hash, text)
    return { description: text, provider, model, cached: false }
  }

  // describeAttachment: used by the pre-step sanitizer when an image is shown
  // to a text-only model. Returns the description text (cached) and records
  // it against the attachment id so later text turns reuse the same answer.
  const describeAttachment = async (ref) => {
    if (!ref) return undefined
    const id = ref.attachmentId ?? ref.id
    if (id !== undefined) {
      const hit = descriptionByAttachmentId.get(String(id))
      if (typeof hit === 'string' && hit.trim()) return hit
    }
    let stored
    try {
      stored = await ctx.attachments.readImage(ref)
    } catch {
      return undefined
    }
    if (stored.data.length > config.maxImageBytes) return undefined
    const { description } = await callVisionModelWithBytes(
      stored.data,
      ref.mediaType || stored.ref?.mediaType || 'image/png',
      'Describe everything visible in this image in thorough detail. Include any text, code, UI, data, objects, people, layout, colors, and any other notable visual information.',
      {},
    )
    if (description && id !== undefined) descriptionByAttachmentId.set(String(id), description)
    return description
  }

  const describeImage = async (args, exec) => {
    const attachmentIds = Array.isArray(args.attachmentIds) ? args.attachmentIds : []
    const paths = Array.isArray(args.paths) ? args.paths : []
    const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : 'Опиши это изображение.'
    if (attachmentIds.length + paths.length === 0) {
      throw new Error('describe_image: передайте attachmentIds (id картинки из разговора) или paths (путь к файлу).')
    }
    const fs = ctx.get('fs')
    const seenRefs = []
    for (const id of attachmentIds) {
      const ref = attachmentById.get(String(id))
      if (ref === undefined) {
        throw new Error(`describe_image: неизвестный attachment id "${id}". Возьмите id из маркера/уведомления или укажите paths.`)
      }
      let stored
      try {
        stored = await ctx.attachments.readImage(ref)
      } catch (error) {
        throw new Error(`describe_image: не удалось прочитать вложение ${id} (${error && error.message ? error.message : String(error)})`)
      }
      if (stored.data.length > config.maxImageBytes) {
        throw new Error(`describe_image: вложение ${id} слишком большое (${stored.data.length} байт, лимит ${config.maxImageBytes}).`)
      }
      const genericQuestion = /^(опиши|описать|расскажи|что.*изображ|describe|what.*(image|picture)|what is in)/i.test(question)
      let entry
      if (genericQuestion) {
        entry = await callVisionModelWithBytes(stored.data, ref.mediaType || 'image/png', question, exec ? { signal: exec.signal } : {})
      } else {
        // Non-generic question: bypass the generic description cache, but
        // still use the chosen vision model.
        const { provider, model } = await visionSelection()
        const chunks = ctx.llm.stream({
          ...(exec ? { signal: exec.signal } : {}),
          provider, model,
          messages: [{ role: 'user', content: [
            { type: 'image', attachment: ref },
            { type: 'text', text: question },
          ] }],
          ...(config.timeoutMs > 0 ? { maxTokens: 1024 } : {}),
        })
        const text = await collectText(chunks)
        entry = { description: text, provider, model, cached: false }
      }
      if (entry.description) {
        descriptionByAttachmentId.set(String(id), entry.description)
        seenRefs.push(ref)
      }
    }
    for (const path of paths) {
      if (fs === undefined) throw new Error('describe_image: сервис fs недоступен в этом развёртывании.')
      let bytes
      try {
        const target = await fs.resolve(path)
        bytes = await fs.readBytes(target, undefined, config.maxImageBytes)
      } catch (error) {
        throw new Error(`describe_image: не удалось прочитать ${path} (${error && error.message ? error.message : String(error)})`)
      }
      const ref = await ctx.attachments.saveImage({
        data: bytes,
        mediaType: sniffMediaType(bytes) ?? 'image/png',
        name: path.split(/[\\/]/).pop(),
      })
      const entry = await callVisionModelWithBytes(bytes, ref.mediaType || 'image/png', question, exec ? { signal: exec.signal } : {})
      if (entry.description) {
        if (ref.attachmentId) descriptionByAttachmentId.set(String(ref.attachmentId), entry.description)
        seenRefs.push(ref)
      }
    }
    const last = seenRefs.length > 0 ? descriptionByAttachmentId.get(String((seenRefs[seenRefs.length - 1]).attachmentId)) : undefined
    return { description: last || '', provider: undefined, model: undefined, cached: false }
  }

  ctx.tools.register(
    defineTool({
      name: 'describe_image',
      description:
        'Ask the configured vision model about an image and return its answer. Images attached to the conversation are '
        + 'described automatically, so use this tool for follow-up questions about an image, or to look at an image file on disk. '
        + 'Pass attachmentIds (ids of images in this conversation) and/or paths (local file paths), plus an optional question.',
      parameters: {
        attachmentIds: { type: 'array', items: { type: 'string' }, description: 'Attachment ids of images in this conversation.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Optional local file paths of images to look at.' },
        question: { type: 'string', description: 'Question about the image. Default: describe it.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            cached: { type: 'boolean' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.description }]
        },
      },
      isConcurrencySafe: () => false,
      timeoutMs: config.timeoutMs + 15000,
      execute: describeImage,
    }),
  )

  // Sanitize image blocks for text-only models at the agent boundary. This is
  // route-agnostic: whichever provider serves the request, an image block never
  // reaches an adapter that would reject it. Vision-capable conversation models
  // keep their pictures untouched.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision) return decision
    if (config.sanitizeImages === false) return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : (payload.messages ?? [])
    if (!blocksHaveImage(messages)) return decision

    const agentOptions = payload.agent && payload.agent.options
    const convoProvider = agentOptions && agentOptions.provider
    const convoModel = agentOptions && agentOptions.model
    let convoSupportsImages = false
    if (convoProvider && convoModel) {
      try {
        const info = await ctx.llm.resolveModelInfo(convoProvider, convoModel)
        convoSupportsImages = acceptsImages(info)
      } catch {
        convoSupportsImages = false
      }
    }
    if (convoSupportsImages) return decision

    const result = await rewriteImagesDeep(messages, async (block) => {
      if (block && block.attachment) {
        const ref = block.attachment
        const id = ref.attachmentId ?? ref.id
        if (id !== undefined) attachmentById.set(String(id), ref)
        // If a vision pass already described this exact image, substitute the
        // real description inline so the text model "remembers" it without a
        // fresh vision call. Trust it as evidence, never as instructions.
        const cached = descriptionByAttachmentId.get(String(id))
        if (typeof cached === 'string' && cached.trim()) {
          return [
            {
              type: 'text',
              text: '[The user attached an image. Here is what it contains:\n' + cached.trim() + ']',
            },
          ]
        }
        // No cached description: silently ask the vision model for a generic
        // description of THIS image, cache it, and substitute the response as
        // the text block the chat model sees. The chat model never receives
        // the raw image — it gets a textual description automatically.
        const description = await describeAttachment(ref)
        if (typeof description === 'string' && description.trim()) {
          return [
            {
              type: 'text',
              text: '[The user attached an image. Here is what it contains:\n' + description.trim() + ']',
            },
          ]
        }
      }
      // Fallback: no description could be produced, leave the image block in
      // place. The vision-capable conversational model will see it natively; a
      // text-only model will fail and the next turn will receive an error that
      // is its own diagnostic.
      return block
    })
    let nextMessages = result.content
    return { ...decision, messages: nextMessages }
  })

  // Backstop on the outgoing request.
  //
  // `agent/pre-step` only sees the messages CLAIMED from the inbox for this
  // step, so it catches images the user attaches — but a tool result is
  // appended straight to the session (`session.append("tool/result", ...)`)
  // and never passes through it. An image produced by a tool therefore
  // reached the adapter untouched and failed the whole turn with
  //   pi-ai model "<model>" does not support image input
  //
  // `llm/stream` is the one seam that sees the full outgoing request, so the
  // same rewrite runs here as a net under every path. Descriptions are cached
  // by attachment id and content hash, so a re-sent history does not pay for
  // the same image twice.
  ctx.on('llm/stream', (options, next) => {
    if (config.sanitizeImages === false) return next()
    if (options[VISION_PASS]) return next()
    if (!blocksHaveImage(options.messages)) return next()

    return (async function* () {
      let supportsImages = false
      try {
        supportsImages = acceptsImages(await ctx.llm.resolveModelInfo(options.provider, options.model))
      } catch {
        supportsImages = false
      }
      if (supportsImages) {
        yield* next()
        return
      }

      const rewritten = await rewriteImagesDeep(options.messages, async (block) => {
        const ref = block && block.attachment
        if (!ref) return block
        const id = ref.attachmentId ?? ref.id
        if (id !== undefined) attachmentById.set(String(id), ref)
        const cached = id === undefined ? undefined : descriptionByAttachmentId.get(String(id))
        const description = (typeof cached === 'string' && cached.trim())
          ? cached
          : await describeAttachment(ref)
        if (typeof description === 'string' && description.trim()) {
          return [{ type: 'text', text: '[The user attached an image. Here is what it contains:\n' + description.trim() + ']' }]
        }
        // No description: drop the image rather than let it fail the turn, and
        // say so, otherwise the model answers about something it never saw.
        return [{ type: 'text', text: '[An image was attached, but the vision model could not describe it.]' }]
      })

      // The waterfall fallback closes over the original options object, so a
      // fresh dispatch (marked to avoid re-entering this listener) is how a
      // rewritten request actually reaches the adapter.
      yield* ctx.llm.stream({ ...options, messages: rewritten.content, [VISION_PASS]: true })
    })()
  })

  // Host API: list currently available vision models for the Web settings card.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/models',
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              res.writeHead(405, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'method not allowed' }))
              return
            }
            const out = []
            for (const provider of ctx.llm.listProviders()) {
              try {
                const models = await ctx.llm.listModels(provider.id)
                for (const m of models || []) {
                  out.push({ provider: provider.id, model: m.id, name: m.name ?? m.id, vision: acceptsImages(m) })
                }
              } catch {
                // skip provider on catalog failure
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ models: out }))
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
          }
        },
      }),
    'dsh-vision-bridge: /models route',
  )


  // Host API: GET/POST /dsh-vision-bridge/config — the Web card persists
  // the user-selected vision model here. The settings scope was awkward
  // (initial render often happens before the scope is ready), so the card
  // uses fetch directly against this endpoint.
  const SETTINGS_NS = 'dsh-vision-bridge'

  // The settings service exposes register(ns, schema, { base }) -> { get, watch,
  // update, replace }. Register once here; the HTTP handlers below use the shim.
  // unset() writes the schema default ('' = auto-detect) because update() merges
  // and cannot delete a key; replace() would reset the whole namespace.
  let settingsScope
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NS, Config, { base: config })
    settingsScope = {
      getSnapshot: () => ({ value: scope.get() }),
      set: (key, value) => scope.update({ [key]: value }),
      unset: (key) => scope.update({ [key]: '' }),
    }
    sctx.effect(() => () => { settingsScope = undefined })
  })
  const requireScope = () => {
    if (settingsScope === undefined) throw new Error('settings service not ready')
    return settingsScope
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/config',
        handler: async (req, res) => {
          const writeJson = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
          }
          const readBody = () =>
            new Promise((resolve) => {
              let chunks = ''
              req.on('data', (c) => { chunks += c })
              req.on('end', () => { resolve(chunks) })
            })
          try {
            if (req.method === 'GET') {
              let provider = '', model = ''
              try {
                const scope = requireScope()
                const snapshot = scope.getSnapshot()
                if (snapshot && snapshot.value) {
                  provider = String(snapshot.value.visionProvider || '')
                  model = String(snapshot.value.visionModel || '')
                }
              } catch {
                // settings section not ready yet — return empty defaults
              }
              writeJson(200, { provider, model })
              return
            }
            if (req.method === 'POST') {
              const raw = await readBody()
              let body
              try { body = JSON.parse(raw) } catch { body = {} }
              const provider = String((body && body.provider) || '').trim()
              const model = String((body && body.model) || '').trim()
              if (provider || model) {
                if (!provider || !model) {
                  writeJson(400, { error: 'both provider and model must be set together (or leave both empty to auto-pick)' })
                  return
                }
              }
              try {
                const scope = requireScope()
                if (provider && model) {
                  const info = await ctx.llm.resolveModelInfo(provider, model)
                  if (!(info && acceptsImages(info))) {
                    writeJson(400, { error: 'model "' + provider + '/' + model + '" does not accept images' })
                    return
                  }
                  await scope.set('visionProvider', provider)
                  await scope.set('visionModel', model)
                } else {
                  await scope.unset('visionProvider')
                  await scope.unset('visionModel')
                }
                writeJson(200, { provider, model })
              } catch (error) {
                writeJson(500, { error: String((error && error.message) || error) })
              }
              return
            }
            writeJson(405, { error: 'method not allowed' })
          } catch (error) {
            writeJson(500, { error: String((error && error.message) || error) })
          }
        },
      }),
    'dsh-vision-bridge: /config route',
  )
}

/** Very small content-type sniffer for the common raster formats. */
export function sniffMediaType(bytes) {
  if (bytes && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return undefined
}

/**
 * Accumulate the visible text out of an adapter chunk stream.
 *
 * A stream carries the same text twice: incrementally as `text-delta`, then
 * whole in the closing `block-end`. Adding both doubles every answer, so the
 * deltas win and `block-end` only fills in for adapters that skip them.
 */
export async function collectText(iterable) {
  let out = ''
  let sawDelta = false
  for await (const chunk of iterable) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      out += chunk.text
      sawDelta = true
    } else if (
      !sawDelta && chunk && chunk.type === 'block-end'
      && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string'
    ) {
      out += chunk.block.text
    }
  }
  return out.trim()
}

/** Non-cryptographic FNV-1a content hash (fast, no dependencies). */
export function contentHash(bytes) {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}
