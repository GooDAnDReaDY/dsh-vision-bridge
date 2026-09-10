// dsh-vision-bridge — tools: grounding domain (#206).
// Registrations moved verbatim from lib/index.js apply(); closure state
// arrives via the deps object `d`.

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  scaleBbox,
  sniffMediaType,
} from '../vision-core.js'

export function registerGroundingTools(d) {
const { ctx, config, attachmentById, descriptionByAttachmentId, descriptionByHash, batches, startBatch, callVisionModelWithBytes, visionSelection, resolveImageBytes, resolveSourceBytes, collectText, describeImage, effectivePrompt, liveChannels, groundingPrompt, parseBbox, tesseractAvailable } = d

ctx.tools.register(defineTool({
    name: 'vision_ground', description: 'Locate a target in an image → bbox [x1,y1,x2,y2] in 0-1000. Use for "where is the button".',
    parameters: { attachmentId: { type: 'string', description: 'Attachment id of the image' }, target: { type: 'string', description: 'What to locate (e.g. "send button")' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { bbox: { type: 'array', items: { type: 'number' } }, description: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: v.bbox && v.bbox.length ? `bbox ${JSON.stringify(v.bbox)} — ${v.description}` : `not found — ${v.description}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, target }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_ground: unknown attachmentId ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_ground: cannot read image');
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, groundingPrompt(target), {});
      return { bbox: parseBbox(description || '') || [], description: description || '' };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_crop', description: 'Crop an image to a bbox or phrase. Without sharp returns bbox only — real PNG crop when sharp is installed.',
    parameters: { attachmentId: { type: 'string' }, region: { type: 'string', description: 'bbox "x1,y1,x2,y2" in 0-1000 or phrase like "top-right"' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { bbox: { type: 'array', items: { type: 'number' } }, note: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: v.bbox && v.bbox.length ? `crop bbox ${JSON.stringify(v.bbox)} — ${v.note}` : v.note}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, region }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_crop: unknown ${attachmentId}`);
      let bbox = []; if (/^\s*\d/.test(region)) { const parts = region.split(/[,\s]+/).map(Number); if (parts.length===4 && parts.every((n)=>!isNaN(n))) bbox = parts; }
      else { const src = await resolveImageBytes(ref); const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, groundingPrompt(region), {}); bbox = parseBbox(description || '') || []; }
      // ponytail: no sharp dep — bbox only. Upgrade: if sharp, do s.data → sharp → extract → saveImage → return attachmentId
      return { bbox, note: bbox.length ? 'bbox ready — with sharp, PNG crop here' : 'region not found' };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_detect', description: 'Detect all elements of a kind → [{label,bbox}]. Use for "which buttons are present".',
    parameters: { attachmentId: { type: 'string' }, kind: { type: 'string', description: 'Kind, e.g. "buttons" or "input fields"' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { items: { type: 'array', items: { type: 'object', properties: { label: {type:'string'}, bbox:{type:'array',items:{type:'number'}} }, additionalProperties: false } }, raw: {type:'string'} } }, render(_a,v){ return [{type:'text',text: v.items.length ? JSON.stringify(v.items,null,2) : v.raw}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, kind }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_detect: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref);
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, `List every "${kind}" in this image. Reply with strict JSON {"items":[{"label":string,"bbox":[x1,y1,x2,y2]}]} in 0-1000 coords.`, {});
      let items = []; try { const j = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0]||''); if (Array.isArray(j.items)) items = j.items; } catch {}
      return { items, raw: description || '' };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_compare', description: 'Compare ≥2 images → deltas. All images sent simultaneously for joint analysis.',
    parameters: { attachmentIds: { type: 'array', items: { type: 'string' } }, question: { type: 'string', description: 'What to compare' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { deltas: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.deltas}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentIds, question }, exec) => {
      if (!Array.isArray(attachmentIds) || attachmentIds.length < 2) throw new Error('vision_compare: need ≥2 attachmentIds');
      // Block 0.4.0 (#74): honest multi-image — all images in one message.
      const imageBlocks = []
      const savedRefs = []
      for (const id of attachmentIds) {
        const ref = attachmentById.get(String(id)); if (!ref) throw new Error(`vision_compare: unknown ${id}`)
        const src = await resolveImageBytes(ref)
        // Save each to a real ref so the adapter can resolve it.
        const saved = await ctx.attachments.saveImage({ data: src.bytes, mediaType: src.contentType, name: `compare-${id}` })
        savedRefs.push(saved)
        imageBlocks.push({ type: 'image', attachment: saved })
      }
      imageBlocks.push({ type: 'text', text: effectivePrompt((question || 'List the differences between these images.') + ` (${attachmentIds.length} images provided.) Be specific and structured.`) })
      const { provider, model } = await visionSelection()
      const chunks = ctx.llm.stream({
        ...(exec?.signal ? { signal: exec.signal } : {}),
        provider, model,
        messages: [{ role: 'user', content: imageBlocks }],
        maxTokens: 1024,
      })
      const text = await collectText(chunks)
      return { deltas: text || '' }
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_present', description: 'Publish a local image file as a chat attachment so the user can see it.',
    parameters: { path: { type: 'string', description: 'Local file path to publish' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { attachmentId: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:`published ${v.attachmentId}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ path }) => {
      const fs = ctx.get('fs'); if (!fs) throw new Error('vision_present: fs unavailable');
      const target = await fs.resolve(path); const bytes = await fs.readBytes(target, undefined, config.maxImageBytes);
      const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: sniffMediaType(bytes)||'image/png', name: path.split(/[\\/]/).pop() });
      return { attachmentId: String(ref.attachmentId ?? ref.id ?? '') };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_trace', description: 'Trace shape → SVG (via vision LLM, not potrace).',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { svg: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.svg.slice(0,500)}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_trace: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, 'Trace this shape into SVG. Reply with strict JSON {"svg":string} where svg is a single <svg> with <path>. No commentary.', {});
      let svg = ''; try { const j = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0]||''); svg = j.svg || ''; } catch {} return { svg };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_colors', description: 'Dominant colors → palette.',
    parameters: { attachmentId: { type: 'string' }, top: { type: 'number', description: 'how many, default 5' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { palette: { type: 'array', items: { type: 'string' } } } }, render(_a,v){ return [{type:'text',text:JSON.stringify(v.palette)}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, top }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_colors: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, `List the ${top||5} dominant colors as hex. Reply with strict JSON {"palette":["#rrggbb"]}.`, {});
      let palette = []; try { const j = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0]||''); if (Array.isArray(j.palette)) palette = j.palette; } catch {} return { palette };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_extract_foreground', description: 'Cut out foreground → transparent PNG (via LLM bbox + note, real cutout needs SAM3/sharp).',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string' }, bbox: { type: 'array', items: { type: 'number' } } } }, render(_a,v){ return [{type:'text',text:v.note}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_extract_foreground: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, groundingPrompt('the main foreground subject') , {});
      const bbox = parseBbox(description || '') || [];
      // ponytail: no SAM3/sharp — bbox only. Upgrade: SAM3 → saveImage with alpha
      return { note: bbox.length ? `foreground bbox ${JSON.stringify(bbox)} — with SAM3, transparent PNG here` : 'foreground not found', bbox };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_annotate', description: 'Overlay bounding boxes with text labels on an image. Returns annotated PNG.',
    parameters: {
      attachmentId: { type: 'string' },
      annotations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { bbox: { type: 'array', items: { type: 'number' } }, label: { type: 'string' }, color: { type: 'string' } } }, description: 'List of {bbox:[x1,y1,x2,y2], label, color}' },
      strokeWidth: { type: 'number', description: 'Box stroke width in pixels', default: 3 },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { annotatedImage: { type: 'string', description: 'Base64-encoded PNG' }, annotations: { type: 'number' } } }, render(_a,v){ return [{type:'text',text: `Annotated image with ${v.annotations} boxes. Base64 length: ${v.annotatedImage?.length || 0}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, annotations, strokeWidth }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_annotate: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_annotate: cannot read image');
      let sharp = null
      try { sharp = (await import('sharp')).default } catch { throw new Error('vision_annotate: sharp not available') }
      if (!sharp) throw new Error('vision_annotate: sharp not available')
      try {
        const meta = await sharp(src.bytes).metadata()
        const w = meta.width || 1000
        const h = meta.height || 1000
        const sw = strokeWidth || 3
        // Build SVG overlay
        let svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">`
        for (const ann of (annotations || [])) {
          const [x1, y1, x2, y2] = scaleBbox(ann.bbox || [], w, h)
          const color = ann.color || '#ff0000'
          const label = (ann.label || '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]))
          svg += `<rect x="${x1}" y="${y1}" width="${x2-x1}" height="${y2-y1}" fill="none" stroke="${color}" stroke-width="${sw}"/>`
          svg += `<rect x="${x1}" y="${Math.max(0, y1-20)}" width="${Math.max(60, label.length*8)}" height="20" fill="${color}"/>`
          svg += `<text x="${x1+4}" y="${Math.max(14, y1-6)}" fill="white" font-size="14" font-family="sans-serif">${label}</text>`
        }
        svg += '</svg>'
        const overlay = Buffer.from(svg)
        const result = await sharp(src.bytes).composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer()
        return { annotatedImage: result.toString('base64'), annotations: (annotations || []).length }
      } catch (e) {
        throw new Error('vision_annotate: ' + (e?.message || String(e)))
      }
    },
  }))

}
