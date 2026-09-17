// dsh-vision-bridge — tools: grounding domain (#206).
// Registrations moved verbatim from lib/index.js apply(); closure state
// arrives via the deps object `d`.

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  scaleBbox,
  sniffMediaType,
} from '../vision-core.js'
import { cropImageRegion, annotateImage } from '../image-processing.js'

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
    name: 'vision_crop',
    description: 'Crop an image to a bounding box or natural language region. Returns cropped image and creates a new attachment for focused inspection.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment id of the image' },
      region: { type: 'string', description: 'bbox "x1,y1,x2,y2" or "[ymin,xmin,ymax,xmax]" or phrase like "top-right"' },
      target: { type: 'string', description: 'Optional natural language target to locate and crop' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string' },
          bbox: { type: 'array', items: { type: 'number' } },
          width: { type: 'number' },
          height: { type: 'number' },
          size: { type: 'number' },
          note: { type: 'string' }
        }
      },
      render(_a, v) {
        return [{ type: 'text', text: `Cropped region ${JSON.stringify(v.bbox)} (${v.width}x${v.height}) as attachment: ${v.attachmentId}` }]
      }
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, region, target }) => {
      const ref = attachmentById.get(String(attachmentId));
      if (!ref) throw new Error(`vision_crop: unknown attachmentId ${attachmentId}`);
      const src = await resolveImageBytes(ref);
      if (!src) throw new Error('vision_crop: cannot read source image');

      let bbox = [];
      const query = target || region;
      if (query && /^s*\[?s*d/.test(query)) {
        const cleaned = query.replace(/[\[\]]/g, '');
        const parts = cleaned.split(/[,s]+/).map(Number);
        if (parts.length === 4 && parts.every(n => !isNaN(n))) bbox = parts;
      } else if (query) {
        const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, groundingPrompt(query), {});
        bbox = parseBbox(description || '') || [];
      }
      if (!bbox.length) bbox = [0, 0, 1000, 1000];

      const cropped = await cropImageRegion(src.bytes, bbox);
      const newId = 'crop-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      
      let savedAttachmentId = newId;
      if (ctx.attachments && typeof ctx.attachments.saveImage === 'function') {
        try {
          const savedRef = await ctx.attachments.saveImage({
            data: cropped.bytes,
            mediaType: 'image/png',
            name: `crop-${attachmentId}.png`
          });
          if (savedRef && (savedRef.id || savedRef.attachmentId)) {
            savedAttachmentId = String(savedRef.id || savedRef.attachmentId);
          }
        } catch (err) { if (typeof console !== 'undefined' && console.debug) console.debug('[dsh-vision-bridge] saveAttachment grounding fallback:', err?.message || err) }
      }

      attachmentById.set(savedAttachmentId, {
        bytes: cropped.bytes,
        contentType: 'image/png',
        attachmentId: savedAttachmentId,
        metadata: { width: cropped.width, height: cropped.height }
      });

      return {
        attachmentId: savedAttachmentId,
        bbox,
        width: cropped.width,
        height: cropped.height,
        size: cropped.bytes.length,
        note: `Cropped region successfully created as attachment ${savedAttachmentId}`
      };
    }
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
      let items = []; let parseWarning = null; try { const j = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0]||''); if (Array.isArray(j.items)) items = j.items; } catch (err) { parseWarning = 'Failed to parse detection JSON: ' + (err?.message || err) }
      return { items, raw: description || '', ...(parseWarning ? { parseWarning } : {}) };
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
      let svg = ''; let parseWarning = null; try { const j = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0]||''); svg = j.svg || ''; } catch (err) { parseWarning = 'Failed to parse trace JSON: ' + (err?.message || err) } return { svg, ...(parseWarning ? { parseWarning, raw: description || '' } : {}) };
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
      let palette = []; let parseWarning = null; try { const j = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0]||''); if (Array.isArray(j.palette)) palette = j.palette; } catch (err) { parseWarning = 'Failed to parse colors JSON: ' + (err?.message || err) } return { palette, ...(parseWarning ? { parseWarning, raw: description || '' } : {}) };
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
    name: 'vision_annotate',
    description: 'Overlay bounding boxes and text labels on an image. Returns annotated image attachment for visual verification.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment id of the image' },
      annotations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            bbox: { type: 'array', items: { type: 'number' } },
            label: { type: 'string' },
            color: { type: 'string' }
          }
        },
        description: 'List of {bbox:[x1,y1,x2,y2], label, color}'
      },
      thickness: { type: 'number', default: 3, description: 'Border thickness in pixels' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string' },
          annotationCount: { type: 'number' },
          size: { type: 'number' },
          note: { type: 'string' }
        }
      },
      render(_a, v) {
        return [{ type: 'text', text: `Annotated image with ${v.annotationCount} annotations as attachment ${v.attachmentId}` }]
      }
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, annotations, thickness }) => {
      const ref = attachmentById.get(String(attachmentId));
      if (!ref) throw new Error(`vision_annotate: unknown attachmentId ${attachmentId}`);
      const src = await resolveImageBytes(ref);
      if (!src) throw new Error('vision_annotate: cannot read source image');

      const annotated = await annotateImage(src.bytes, annotations || [], { thickness });
      const newId = 'annotated-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      
      let savedId = newId;
      if (ctx.attachments && typeof ctx.attachments.saveImage === 'function') {
        try {
          const savedRef = await ctx.attachments.saveImage({
            data: annotated.bytes,
            mediaType: 'image/png',
            name: `annotated-${attachmentId}.png`
          });
          if (savedRef && (savedRef.id || savedRef.attachmentId)) {
            savedId = String(savedRef.id || savedRef.attachmentId);
          }
        } catch (err) { if (typeof console !== 'undefined' && console.debug) console.debug('[dsh-vision-bridge] saveAttachment preview fallback:', err?.message || err) }
      }

      attachmentById.set(savedId, {
        bytes: annotated.bytes,
        contentType: 'image/png',
        attachmentId: savedId
      });

      return {
        attachmentId: savedId,
        annotationCount: annotated.count,
        size: annotated.bytes.length,
        note: `Image annotated with ${annotated.count} marker(s) saved as attachment ${savedId}`
      };
    }
  }))

}
