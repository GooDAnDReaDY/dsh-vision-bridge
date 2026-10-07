import {
  acceptsImages,
  bestEffort,
  blocksHaveImage,
  extractSessionId,
  rewriteImagesDeep,
  sanitizeAllowed,
  shouldBridgeForModel,
  VISION_PASS,
} from './vision-core.js'

// #242: model-aware tool exposure. When the agent's chat route already has
// native vision, the compensation tools are hidden from that agent through
// the per-agent capability filter (`agent.ctx.tools.restrict`), which the
// core uses for scoped tool masks; extra instruments stay visible.
export const REDUNDANT_FOR_VISION = [
  'describe_image', 'read_image', 'inspect_image',
  'vision_vqa', 'vision_cot', 'vision_self_check', 'vision_describe_structured',
  'vision_ui_layout', 'vision_translate_image', 'vision_to_code', 'vision_ocr',
  'vision_audit_accessibility', 'vision_ui_flow', 'vision_math_extract',
  'vision_extract_formula', 'vision_extract_table', 'vision_extract_structured',
  'vision_scan_barcode', 'vision_qr_read', 'vision_trace', 'vision_colors',
  'vision_quality_check', 'vision_diff', 'vision_pixel_diff', 'vision_ground',
  'vision_detect', 'vision_crop', 'vision_annotate', 'vision_extract_foreground',
]

// #241: attach tools publish images for the CHAT model to look at, so they
// are the mirror image of the compensation list: a text-only route cannot
// use them and gets this mask instead.
export const ATTACH_ONLY_TOOLS = ['vision_attach_pages', 'vision_attach_frames', 'vision_attach_images']

export function setupAgentBoundary(ctx, deps) {
  const {
    config,
    descriptionByAttachmentId,
    recordAttachment,
    describeAttachment,
    setLastUserText,
    logger,
  } = deps

  let restrictUnavailable = false
  const agentToolPolicy = new WeakMap()

  const routeOf = (agent) => {
    try {
      const routed = agent && agent.session && typeof agent.session.requestHeader === 'function'
        ? agent.session.requestHeader()?.config
        : undefined
      return {
        provider: (routed && routed.provider) || (agent && agent.options && agent.options.provider),
        model: (routed && routed.model) || (agent && agent.options && agent.options.model),
      }
    } catch (_err) {
      // safe fallback if session header probe fails
      return {}
    }
  }

  const liftAgentMask = (agent) => {
    const prev = agentToolPolicy.get(agent)
    if (prev && typeof prev.dispose === 'function') {
      bestEffort('agentMask.dispose', () => prev.dispose())
    }
    agentToolPolicy.delete(agent)
  }

  const applyAgentToolPolicy = async (agent, signal) => {
    if (restrictUnavailable || !agent) return
    if (config.hideRedundantTools === false) {
      liftAgentMask(agent)
      return
    }
    const { provider, model } = routeOf(agent)
    if (!provider || !model) {
      liftAgentMask(agent)
      return
    }
    const key = provider + '/' + model + '|' + (config.nativePassthrough || 'prefer')
    const prev = agentToolPolicy.get(agent)
    if (prev && prev.key === key) return

    let supportsImages = false
    try {
      supportsImages = acceptsImages(await ctx.llm.resolveModelInfo(provider, model, signal))
    } catch (_err) {
      supportsImages = false
    }

    if (prev && typeof prev.dispose === 'function') {
      bestEffort('agentMask.dispose', () => prev.dispose())
    }
    agentToolPolicy.delete(agent)

    const deny = shouldBridgeForModel(config, supportsImages) ? ATTACH_ONLY_TOOLS : REDUNDANT_FOR_VISION
    if (deny.length === 0) {
      agentToolPolicy.set(agent, { key, dispose: null })
      return
    }

    try {
      const scoped = agent.ctx && (agent.ctx.tools || (typeof agent.ctx.get === 'function' ? agent.ctx.get('tools') : null))
      if (!scoped || typeof scoped.restrict !== 'function') {
        restrictUnavailable = true
        logger.warn('[dsh-vision-bridge] per-agent tools.restrict() is unavailable; keeping the full tool list for vision models')
        return
      }
      const dispose = scoped.restrict({ deny })
      agentToolPolicy.set(agent, { key, dispose: typeof dispose === 'function' ? dispose : null })
    } catch (err) {
      restrictUnavailable = true
      logger.warn('[dsh-vision-bridge] tools.restrict() failed; keeping the full tool list:', err && err.message)
    }
  }

  // 1. Sanitize image blocks for text-only models and index incoming attachments
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision) {
      const messages = Array.isArray(decision.messages) ? decision.messages : (payload.messages ?? [])
      if (blocksHaveImage(messages)) {
        const sessionId = extractSessionId(payload)
        rewriteImagesDeep(messages, (block) => {
          if (block && block.attachment) {
            const ref = block.attachment
            const id = ref.attachmentId ?? ref.id
            if (id !== undefined) recordAttachment(id, ref, sessionId)
          }
          return block
        }).catch((_err) => {
          // non-blocking deep attachment indexing
        })

        if (sanitizeAllowed(config)) {
          bestEffort('chat.lastUserText', () => {
            const lastUserMsg = [...messages].reverse().find((m) => m && m.role === 'user')
            const txt = lastUserMsg && Array.isArray(lastUserMsg.content)
              ? lastUserMsg.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ')
              : (lastUserMsg && typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '')
            if (typeof txt === 'string' && txt.trim()) setLastUserText(sessionId, txt.trim())
          })
        }
      }
    }

    try {
      await applyAgentToolPolicy(payload && payload.agent, payload && payload.signal)
    } catch (err) {
      logger.debug('[dsh-vision-bridge] applyAgentToolPolicy failed:', err?.message || err)
    }

    return decision
  })

  // 2. Outgoing backstop on llm/stream
  ctx.on('llm/stream', (options, next) => {
    if (!sanitizeAllowed(config)) return next()
    if (options[VISION_PASS]) return next()
    if (!blocksHaveImage(options.messages)) return next()

    return (async function* () {
      let supportsImages = false
      try {
        supportsImages = acceptsImages(await ctx.llm.resolveModelInfo(options.provider, options.model))
      } catch (_err) {
        supportsImages = false
      }
      if (!shouldBridgeForModel(config, supportsImages)) {
        yield* next()
        return
      }

      const rewritten = await rewriteImagesDeep(options.messages, async (block) => {
        const ref = block && block.attachment
        if (!ref) return block
        const id = ref.attachmentId ?? ref.id
        if (id !== undefined) recordAttachment(id, ref)
        const cached = id === undefined ? undefined : descriptionByAttachmentId.get(String(id))
        const description = (typeof cached === 'string' && cached.trim())
          ? cached
          : await describeAttachment(ref)
        if (typeof description === 'string' && description.trim()) {
          const idStr = id !== undefined ? ` (attachmentId: "${id}")` : ''
          const toolHint = id !== undefined
            ? `To inspect specific visual details, check hypotheses, or answer follow-up questions about this image, call the "describe_image" tool with attachmentIds: ["${id}"] and your question.\n`
            : ''
          return [{ type: 'text', text: `[The user attached an image${idStr}. ${toolHint}Here is what the image contains:\n${description.trim()}]` }]
        }
        return [{ type: 'text', text: '[An image was attached, but the vision model could not describe it.]' }]
      })

      yield* ctx.llm.stream({ ...options, messages: rewritten.content, [VISION_PASS]: true })
    })()
  })

  // 3. Modality bridge: advertise image input support on llm models when bridge is enabled
  ctx.effect(() => {
    let origResolveModelInfo = null
    let origListModels = null

    if (typeof ctx.llm.resolveModelInfo === 'function') {
      origResolveModelInfo = ctx.llm.resolveModelInfo
      ctx.llm.resolveModelInfo = async function bridgedResolveModelInfo(provider, model, signal) {
        const info = await origResolveModelInfo.call(ctx.llm, provider, model, signal)
        if (!info) return info
        if (!sanitizeAllowed(config)) return info
        if (Array.isArray(info.inputModalities) && !info.inputModalities.includes('image')) {
          return {
            ...info,
            inputModalities: [...info.inputModalities, 'image'],
            _nativeInputModalities: info.inputModalities,
          }
        }
        return info
      }
    }

    if (typeof ctx.llm.listModels === 'function') {
      origListModels = ctx.llm.listModels
      ctx.llm.listModels = async function bridgedListModels(provider) {
        const models = await origListModels.call(ctx.llm, provider)
        if (!Array.isArray(models) || !sanitizeAllowed(config)) return models
        return models.map((m) => {
          if (m && Array.isArray(m.inputModalities) && !m.inputModalities.includes('image')) {
            return {
              ...m,
              inputModalities: [...m.inputModalities, 'image'],
              _nativeInputModalities: m.inputModalities,
            }
          }
          return m
        })
      }
    }

    return () => {
      if (origResolveModelInfo) ctx.llm.resolveModelInfo = origResolveModelInfo
      if (origListModels) ctx.llm.listModels = origListModels
    }
  }, 'dsh-vision-bridge: llm modality bridge')
}
