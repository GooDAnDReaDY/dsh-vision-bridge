// dsh-vision-bridge — tools: core domain (#206).
// Registrations moved verbatim from lib/index.js apply(); closure state
// arrives via the deps object `d`.

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  isPathAllowed,
  safeFetch,
  sniffMediaType,
} from '../vision-core.js'

export function registerCoreTools(d) {
  const {
    ctx,
    config,
    attachmentById,
    descriptionByAttachmentId,
    descriptionByHash,
    batches,
    startBatch,
    callVisionModelWithBytes,
    visionSelection,
    resolveImageBytes,
    resolveSourceBytes,
    collectText,
    describeImage,
    effectivePrompt,
    liveChannels,
    groundingPrompt,
    parseBbox,
    tesseractAvailable,
  } = d

  // #295: Unified vision meta-tool for inspecting images in various modes
  ctx.tools.register(
    defineTool({
      name: 'vision_inspect',
      description:
        'Unified vision meta-tool for inspecting images in various modes: describe, ocr, detect_ui, or extract_data. '
        + 'Accepts an attachmentId, a local file path, or an http(s) URL. '
        + 'Optimized for high accuracy and fast structured responses.',
      parameters: {
        source: { type: 'string', description: 'One of: attachmentId, local file path, or http(s) URL of the image.' },
        mode: {
          type: 'string',
          enum: ['describe', 'ocr', 'detect_ui', 'extract_data'],
          description: 'Inspection mode. "describe": general description; "ocr": extract text; "detect_ui": find UI controls & coords; "extract_data": extract structured JSON.',
        },
        prompt: { type: 'string', description: 'Optional focus question, OCR instruction, or extraction guidelines.' },
        schema: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional JSON schema for structured data extraction when mode="extract_data".',
        },
        detail: { type: 'string', enum: ['auto', 'low', 'high'], description: 'Resolution hint for token economy.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            result: { type: 'string', description: 'Text or JSON string representation of the vision analysis.' },
            mode: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            cached: { type: 'boolean' },
            warnings: { type: 'array', items: { type: 'string' } },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.result }]
        },
      },
      isConcurrencySafe: () => false,
      timeoutMs: config.timeoutMs + 15000,
      execute: async ({ source, mode = 'describe', prompt = '', schema, detail }, exec) => {
        let resolvedBytes = null
        let resolvedType = 'image/png'

        const src = String(source || '').trim()
        if (!src) {
          const lastRef = [...attachmentById.values()].pop()
          if (lastRef) {
            const stored = await ctx.attachments.readImage(lastRef)
            resolvedBytes = stored.data
            resolvedType = lastRef.mediaType || 'image/png'
          } else {
            throw new Error('vision_inspect: source is required (attachmentId, path, or http(s) URL)')
          }
        } else if (/^https?:\/\//i.test(src)) {
          let res
          try {
            res = await safeFetch(src, {
              allowedHosts: config.allowedUrlHosts,
              init: { signal: AbortSignal.timeout(Math.max(1000, config.channelTimeoutMs || 15000)) },
            })
          } catch (e) {
            throw new Error(`vision_inspect: ${e && e.message ? e.message : e}`)
          }
          if (!res.ok) throw new Error(`vision_inspect: GET ${src} -> ${res.status}`)
          const declared = Number(res.headers.get('content-length') || 0)
          if (declared > config.maxImageBytes) throw new Error(`vision_inspect: body of ${declared} bytes exceeds limit`)
          resolvedBytes = Buffer.from(await res.arrayBuffer())
          if (resolvedBytes.length > config.maxImageBytes) throw new Error('vision_inspect: body exceeds image limit')
          resolvedType = res.headers.get('content-type') || sniffMediaType(resolvedBytes) || 'image/png'
        } else if (attachmentById.has(src)) {
          const ref = attachmentById.get(src)
          const stored = await ctx.attachments.readImage(ref)
          resolvedBytes = stored.data
          resolvedType = ref.mediaType || 'image/png'
        } else {
          const fs = ctx.get('fs')
          if (!isPathAllowed(src, config.allowedImageDirs)) throw new Error(`vision_inspect: path outside allowedImageDirs: ${src}`)
          if (fs) {
            const target = await fs.resolve(src)
            resolvedBytes = await fs.readBytes(target, undefined, config.maxImageBytes)
            resolvedType = sniffMediaType(resolvedBytes) || 'image/png'
          } else {
            throw new Error(`vision_inspect: could not resolve "${src}"`)
          }
        }

        let effectiveQuestion = prompt || ''
        if (mode === 'ocr') {
          effectiveQuestion = effectiveQuestion
            ? `Extract all readable text from this image exactly as written. Focus on: ${effectiveQuestion}`
            : 'Extract all readable text from this image exactly as written, preserving layout, headings, and lines.'
        } else if (mode === 'detect_ui') {
          effectiveQuestion = effectiveQuestion
            ? `Detect and list all user interface elements (buttons, inputs, icons, cards). Query: ${effectiveQuestion}. Provide labels and approximate bounding boxes [ymin, xmin, ymax, xmax] scaled 0-1000.`
            : 'Detect and list all UI elements (buttons, inputs, links, headings, navigation). For each element, provide type, label/text, and bounding box [ymin, xmin, ymax, xmax] on a 0-1000 scale.'
        } else if (mode === 'extract_data') {
          effectiveQuestion = schema
            ? `Extract structured data from this image conforming to this JSON schema: ${JSON.stringify(schema)}. Output valid JSON only.`
            : (effectiveQuestion ? `Extract structured data from this image. Instructions: ${effectiveQuestion}. Output valid JSON.` : 'Extract all key structured data (tables, key-value pairs, entities) as valid JSON.')
        } else {
          effectiveQuestion = effectiveQuestion || 'Describe this image in comprehensive detail.'
        }

        const r = await callVisionModelWithBytes(resolvedBytes, resolvedType, effectiveQuestion, {
          ...(exec ? { signal: exec.signal } : {}),
          detail,
        })

        return {
          result: r.description || '',
          mode,
          provider: r.channel ? String(r.channel.type || '') : undefined,
          model: r.channel ? String(r.channel.model || '') : undefined,
          cached: !!r.cached,
          warnings: Array.isArray(r.warnings) ? r.warnings : [],
        }
      },
    }),
  )

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
        urls: { type: 'array', items: { type: 'string' }, description: 'Optional http(s) URLs of images to look at (#95).' },
        question: { type: 'string', description: 'Question about the image. Default: describe it.' },
        detail: { type: 'string', enum: ['auto', 'low', 'high'], description: 'Resolution hint for token economy on large images (#96).' },
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

  ctx.tools.register(
    defineTool({
      name: 'read_image',
      description:
        'Read an image file and return its visual content as text (OCR, layout, objects). '
        + 'Use this instead of the built-in read_image when the current model cannot accept images directly.',
      parameters: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Local image file paths to read.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Optional http(s) URLs of images to read (#95).' },
        question: { type: 'string', description: 'Optional focus question about the image(s).' },
        detail: { type: 'string', enum: ['auto', 'low', 'high'], description: 'Resolution hint for token economy on large images (#96).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { description: { type: 'string' } },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.description }]
        },
      },
      isConcurrencySafe: () => false,
      timeoutMs: config.timeoutMs + 15000,
      execute: async (args, exec) => {
        const r = await describeImage({ paths: args.paths, attachmentIds: [], urls: args.urls, question: args.question || '', detail: args.detail }, exec)
        return { description: r.description || '' }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'inspect_image',
      description:
        'Inspect an image and return a detailed description. Accepts an attachmentId, a local file path, or an http(s) URL (#95). '
        + 'Use for follow-up questions or to look at an image that is not attached to the conversation.',
      parameters: {
        source: { type: 'string', description: 'One of: attachmentId, local file path, or http(s) URL of the image.' },
        question: { type: 'string', description: 'Question about the image. Default: describe it.' },
        detail: { type: 'string', enum: ['auto', 'low', 'high'], description: 'Resolution hint for token economy on large images (#96).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { description: { type: 'string' } },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.description }]
        },
      },
      isConcurrencySafe: () => false,
      timeoutMs: config.timeoutMs + 15000,
      execute: async ({ source, question, detail }, exec) => {
        const src = String(source || '').trim()
        if (!src) throw new Error('inspect_image: source is required (attachmentId, path, or http(s) URL)')
        if (/^https?:\/\//i.test(src)) {
          let res
          try {
            res = await safeFetch(src, {
              allowedHosts: config.allowedUrlHosts,
              init: { signal: AbortSignal.timeout(Math.max(1000, config.channelTimeoutMs || 15000)) },
            })
          } catch (e) {
            throw new Error(`inspect_image: ${e && e.message ? e.message : e}`)
          }
          if (!res.ok) throw new Error(`inspect_image: GET ${src} -> ${res.status}`)
          const declared = Number(res.headers.get('content-length') || 0)
          if (declared > config.maxImageBytes) throw new Error(`inspect_image: GET ${src} body of ${declared} bytes exceeds the ${config.maxImageBytes} limit`)
          const bytes = Buffer.from(await res.arrayBuffer())
          if (bytes.length > config.maxImageBytes) throw new Error(`inspect_image: GET ${src} body exceeds the ${config.maxImageBytes} limit`)
          const contentType = res.headers.get('content-type') || sniffMediaType(bytes) || 'image/png'
          const r = await callVisionModelWithBytes(bytes, contentType, question || 'Describe this image.', { ...(exec ? { signal: exec.signal } : {}), detail })
          return { description: r.description || '' }
        }
        if (attachmentById.has(src)) {
          const ref = attachmentById.get(src)
          const stored = await ctx.attachments.readImage(ref)
          const r = await callVisionModelWithBytes(stored.data, ref.mediaType || 'image/png', question || 'Describe this image.', { ...(exec ? { signal: exec.signal } : {}), detail })
          return { description: r.description || '' }
        }
        const fs = ctx.get('fs')
        if (!isPathAllowed(src, config.allowedImageDirs)) throw new Error(`inspect_image: path outside allowedImageDirs: ${src}`)
        if (fs) {
          const target = await fs.resolve(src)
          const bytes = await fs.readBytes(target, undefined, config.maxImageBytes)
          const r = await callVisionModelWithBytes(bytes, sniffMediaType(bytes) || 'image/png', question || 'Describe this image.', { ...(exec ? { signal: exec.signal } : {}), detail })
          return { description: r.description || '' }
        }
        throw new Error(`inspect_image: could not resolve "${src}" (not an attachmentId, an allowed path, or an http(s) URL)`)
      },
    }),
  )
}
