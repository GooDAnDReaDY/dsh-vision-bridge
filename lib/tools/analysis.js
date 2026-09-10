// dsh-vision-bridge — tools: analysis domain (#206).
// Registrations moved verbatim from lib/index.js apply(); closure state
// arrives via the deps object `d`.

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  checkImageQuality,
} from '../vision-core.js'
import { runChannels } from '../channels.js'

export function registerAnalysisTools(d) {
const { ctx, config, attachmentById, descriptionByAttachmentId, descriptionByHash, batches, startBatch, callVisionModelWithBytes, visionSelection, resolveImageBytes, resolveSourceBytes, collectText, describeImage, effectivePrompt, liveChannels, groundingPrompt, parseBbox, tesseractAvailable } = d

ctx.tools.register(defineTool({
    name: 'vision_diff', description: 'Compare two attached images and return structured differences (UI before/after). Three-pass flow: each image is described separately, then a JSON diff is derived — the final pass sees image A directly.',
    parameters: {
      attachmentIdA: { type: 'string', description: 'First image (e.g. before)' },
      attachmentIdB: { type: 'string', description: 'Second image (e.g. after)' },
      focus: { type: 'string', description: 'What to focus on (e.g. "header section", "button colors")' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { differences: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { area: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } } } }, summary: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: v.summary + '\n\n' + (v.differences||[]).map(d=>`- ${d.area}: ${d.before} → ${d.after}`).join('\n')}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ attachmentIdA, attachmentIdB, focus }, exec) => {
      const refA = attachmentById.get(String(attachmentIdA)); if (!refA) throw new Error(`vision_diff: unknown ${attachmentIdA}`);
      const refB = attachmentById.get(String(attachmentIdB)); if (!refB) throw new Error(`vision_diff: unknown ${attachmentIdB}`);
      const srcA = await resolveImageBytes(refA); if (!srcA) throw new Error('vision_diff: cannot read first image');
      const srcB = await resolveImageBytes(refB); if (!srcB) throw new Error('vision_diff: cannot read second image');
      const prompt = `Compare these two images${focus ? ', focusing on ' + focus : ''}. Reply with strict JSON {"differences":[{"area":"region name","before":"what was","after":"what is"}],"summary":"one-line summary"}. If no differences, reply with {"differences":[],"summary":"no visible differences"}.`;
      // Send both images by calling vision model twice and asking for comparison
      const { description: descA } = await callVisionModelWithBytes(srcA.bytes, srcA.contentType, 'Image A: ' + (focus || 'describe this image'), { ...(exec ? { signal: exec.signal } : {}) });
      const { description: descB } = await callVisionModelWithBytes(srcB.bytes, srcB.contentType, 'Image B: ' + (focus || 'describe this image'), { ...(exec ? { signal: exec.signal } : {}) });
      const { description } = await callVisionModelWithBytes(srcA.bytes, srcA.contentType, `${prompt}\n\nDescription of A: ${descA}\nDescription of B: ${descB}`, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = { differences: [], summary: description || '' }
      try { const j = JSON.parse((description || '').match(/\{[\s\S]*\}/)?.[0] || ''); if (j.differences || j.summary) parsed = j } catch {}
      return parsed;
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_cot', description: 'Chain-of-thought visual reasoning — model plans steps, analyzes, then verifies.',
    parameters: { attachmentId: { type: 'string' }, question: { type: 'string', description: 'Question about the image' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { plan: { type: 'string' }, analysis: { type: 'string' }, verification: { type: 'string' }, answer: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: `Plan: ${v.plan}\n\nAnalysis: ${v.analysis}\n\nVerification: ${v.verification}\n\nAnswer: ${v.answer}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 30000,
    execute: async ({ attachmentId, question }, exec) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_cot: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_cot: cannot read image');
      const prompt = `${question}\n\nThink step by step. Reply with strict JSON {"plan":"your approach","analysis":"what you see","verification":"double-check","answer":"final answer"}.`;
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = { plan: '', analysis: description || '', verification: '', answer: '' }
      try { const j = JSON.parse((description || '').match(/\{[\s\S]*\}/)?.[0] || ''); if (j.plan || j.analysis) parsed = j } catch {}
      return parsed;
    },
  }))

if (config.selfCheckEnabled) ctx.tools.register(defineTool({
    name: 'vision_self_check', description: 'Self-check visual hypothesis — model rates confidence, retries with refinement if low.',
    parameters: { attachmentId: { type: 'string' }, hypothesis: { type: 'string', description: 'What to verify (e.g. "the button is blue")' }, threshold: { type: 'number', description: 'Confidence threshold 0-100, below which to retry', default: 70 } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { confidence: { type: 'number' }, verified: { type: 'boolean' }, answer: { type: 'string' }, refined: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: `Confidence: ${v.confidence}%, Verified: ${v.verified}\nAnswer: ${v.answer}${v.refined ? '\nRefined: ' + v.refined : ''}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 45000,
    execute: async ({ attachmentId, hypothesis, threshold }, exec) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_self_check: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_self_check: cannot read image');
      const prompt1 = `Verify this hypothesis about the image: "${hypothesis}". Reply with strict JSON {"answer":"yes/no/partial","confidence":0-100,"reason":"why"}.`
      const { description: r1 } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt1, { ...(exec ? { signal: exec.signal } : {}) })
      let parsed = { answer: r1 || '', confidence: 0, reason: '' }
      try { const j = JSON.parse((r1 || '').match(/\{[\s\S]*\}/)?.[0] || ''); if (typeof j.confidence === 'number') parsed = j } catch {}
      let refined = ''
      if (parsed.confidence < (threshold || 70)) {
        const prompt2 = `Look more carefully. Original hypothesis: "${hypothesis}". Your previous answer was "${parsed.answer}" with confidence ${parsed.confidence}%. Provide a refined answer.`
        const { description: r2 } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt2, { ...(exec ? { signal: exec.signal } : {}) })
        refined = r2 || ''
      }
      return { confidence: parsed.confidence, verified: parsed.confidence >= (threshold || 70), answer: parsed.answer, refined };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_vqa', description: 'Visual Q&A — short answer to a question about an image. Token-efficient alternative to describe_image.',
    parameters: { attachmentId: { type: 'string' }, question: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.answer}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId, question }, exec) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_vqa: unknown ${attachmentId}`)
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_vqa: cannot read')
      if (!question?.trim()) throw new Error('vision_vqa: question is required')
      // Short answer: low maxTokens, direct question.
      const savedRef = await ctx.attachments.saveImage({ data: src.bytes, mediaType: src.contentType, name: 'vqa-input' })
      const { provider, model } = await visionSelection()
      const chunks2 = ctx.llm.stream({ ...(exec?.signal ? {signal: exec.signal} : {}), provider, model,
        messages: [{ role: 'user', content: [{ type: 'image', attachment: savedRef }, { type: 'text', text: effectivePrompt(question) }] }],
        maxTokens: 100,
      })
      const answer = await collectText(chunks2)
      return { answer: answer || '' }
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_ui_layout', description: 'Analyze UI screenshot → structured layout breakdown (header/main/sidebar/footer with sizes and contents) for frontend reproduction.',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { layout: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.layout}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_ui_layout: unknown ${attachmentId}`)
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_ui_layout: cannot read')
      const prompt = 'Analyze this UI screenshot for frontend reproduction. Reply with a structured text breakdown: Header (height, bg, contents), Main (grid/columns/flex, each section), Sidebar (width, contents), Footer (if present). Include font sizes, colors (hex), spacing values where identifiable. Be precise enough to generate HTML/CSS from this alone.'
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, {})
      return { layout: description || '' }
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_pixel_diff', description: 'Compare two attached images via the vision model. Honest scope: image B is analyzed directly while image A is only characterized by its byte size — a semantic hint, NOT a pixel-accurate diff; prefer vision_diff.',
    parameters: { attachmentIdA: { type: 'string' }, attachmentIdB: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { diff: { type: 'string' } } }, render(_a,v){ return [{type:'text',text:v.diff}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 15000,
    execute: async ({ attachmentIdA, attachmentIdB }) => {
      const refA = attachmentById.get(String(attachmentIdA)); const refB = attachmentById.get(String(attachmentIdB));
      if (!refA || !refB) throw new Error('vision_pixel_diff: need both attachmentIds');
      const a = await resolveImageBytes(refA); const b = await resolveImageBytes(refB);
      const { description } = await callVisionModelWithBytes(b.bytes, b.contentType, `This is image B. Image A had hash ${a.bytes.length} bytes. List the visible differences between A and B in strict JSON {"diff":string}. Be specific about what changed and where.`, {});
      return { diff: description || '' };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_quality_check', description: 'Check image quality — blur, lighting, overall score. Use to detect poor-quality inputs before vision processing.',
    parameters: { attachmentId: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { score: { type: 'number' }, blur: { type: 'string' }, lighting: { type: 'number' }, note: { type: 'string' } } }, render(_a,v){ return [{type:'text',text: `Quality: ${v.score}/100, Blur: ${v.blur}, Lighting: ${v.lighting}%\n${v.note}`}] } },
    isConcurrencySafe: () => false, timeoutMs: config.timeoutMs + 10000,
    execute: async ({ attachmentId }) => {
      const ref = attachmentById.get(String(attachmentId)); if (!ref) throw new Error(`vision_quality_check: unknown ${attachmentId}`);
      const src = await resolveImageBytes(ref); if (!src) throw new Error('vision_quality_check: cannot read image');
      return checkImageQuality(src.bytes);
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_ui_flow',
    description: 'Reconstruct a UI user flow / journey graph from multiple screenshots. Returns screen states, user actions, transitions, and Mermaid diagram.',
    parameters: {
      attachmentIds: { type: 'array', items: { type: 'string' }, description: 'Ordered list of screenshot attachment IDs' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Ordered list of local screenshot paths' },
      title: { type: 'string', description: 'Flow name or goal (e.g. "Checkout Flow")' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                step: { type: 'number' },
                screen: { type: 'string' },
                action: { type: 'string' },
                nextScreen: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
          mermaid: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render(_a, v) {
        const stepsText = (v.steps || []).map((s) => s.step + '. **' + s.screen + '** -> [' + s.action + '] -> **' + s.nextScreen + '**\n   ' + s.description).join('\n');
        return [{ type: 'text', text: '### ' + v.title + '\n' + v.summary + '\n\n' + stepsText + '\n\n```mermaid\n' + v.mermaid + '\n```' }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 45000,
    execute: async ({ attachmentIds, paths, title }, exec) => {
      const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
      const pths = Array.isArray(paths) ? paths : [];
      const sources = [...ids.map(id => ({ id })), ...pths.map(p => ({ path: p }))];
      if (sources.length === 0) {
        const lastRefs = [...attachmentById.values()].slice(-4);
        if (lastRefs.length > 0) {
          sources.push(...lastRefs.map(r => ({ id: r.attachmentId || r.id })));
        }
      }
      if (sources.length === 0) throw new Error('vision_ui_flow: no screenshots provided');

      const sampled = sources.slice(0, 6);
      const descs = [];
      for (let i = 0; i < sampled.length; i++) {
        const s = sampled[i];
        const src = await resolveSourceBytes(null, s.id, s.path);
        if (src) {
          const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, 'Analyze Screen ' + (i + 1) + ' of this user flow: identify the screen name/title, key UI elements, and primary call-to-action button.', { ...(exec ? { signal: exec.signal } : {}) });
          descs.push('Screen ' + (i + 1) + ': ' + description);
        }
      }

      const flowTitle = title || 'User Interface Flow';
      const prompt = 'Based on these sequential UI screen descriptions, reconstruct the step-by-step user journey flow. '
        + 'Screens:\n' + descs.join('\n\n') + '\n\n'
        + 'Reply with strict JSON {"title":"' + flowTitle + '","summary":"brief overview of the user journey","steps":[{"step":1,"screen":"Screen name","action":"Click button / submit form","nextScreen":"Target screen name","description":"what happens"}],"mermaid":"graph TD\\n  A[Screen 1] -->|Action| B[Screen 2]"}.';

      const firstSrc = await resolveSourceBytes(null, sampled[0]?.id, sampled[0]?.path);
      const { description } = await callVisionModelWithBytes(firstSrc ? firstSrc.bytes : Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', prompt, { ...(exec ? { signal: exec.signal } : {}) });

      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}

      const steps = Array.isArray(parsed?.steps)
        ? parsed.steps.map((s, idx) => ({
            step: Number(s.step || idx + 1),
            screen: String(s.screen || ('Screen ' + (idx + 1))),
            action: String(s.action || 'Continue'),
            nextScreen: String(s.nextScreen || ('Screen ' + (idx + 2))),
            description: String(s.description || ''),
          }))
        : [];

      return {
        title: String(parsed?.title || flowTitle),
        summary: String(parsed?.summary || 'Sequential user journey reconstructed from screenshots.'),
        steps,
        mermaid: String(parsed?.mermaid || 'graph TD\n  Start --> Screen1\n  Screen1 --> End'),
      };
    },
  }))

if (config.consensusEnabled) ctx.tools.register(defineTool({
    name: 'vision_consensus',
    description: 'Query multiple vision models/channels simultaneously and synthesize a consensus description, eliminating single-model hallucinations.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      question: { type: 'string', description: 'What to describe or verify' },
      minAgreement: { type: 'number', description: 'Minimum number of agreeing channels (default 2)', default: 2 },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          consensus: { type: 'string' },
          modelsQueried: { type: 'array', items: { type: 'string' } },
          discrepancies: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: '### Consensus (Confidence: ' + v.confidence + '%)\n' + v.consensus + '\n\n**Models queried:** ' + v.modelsQueried.join(', ') + (v.discrepancies.length ? '\n\n**Discrepancies:**\n' + v.discrepancies.map(d=>'- ' + d).join('\n') : '') }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 45000,
    execute: async ({ attachmentId, path, question, minAgreement }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_consensus: image source not found');
      const q = effectivePrompt(question || 'Describe this image thoroughly, list all objects, texts, colors, and layout.');

      // #211: consensus runs channels as they will actually be used, with keys resolved.
      const allLive = await liveChannels()
      const channels = allLive.length > 1
        ? allLive.slice(0, 3)
        : []

      const descs = [];
      const modelsQueried = [];

      if (channels.length >= 2) {
        for (const ch of channels) {
          try {
            const r = await runChannels([ch], {
              bytes: src.bytes,
              contentType: src.contentType,
              prompt: q,
              timeoutMs: Math.min(20000, config.channelTimeoutMs || 20000),
              signal: exec?.signal,
            });
            if (r.ok && r.description) {
              descs.push({ model: ch.model || 'channel', desc: r.description });
              modelsQueried.push(ch.model || 'channel');
            }
          } catch {}
        }
      }

      if (descs.length < 2) {
        const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, q, { ...(exec ? { signal: exec.signal } : {}) });
        return {
          consensus: String(description || ''),
          modelsQueried: modelsQueried.length ? modelsQueried : ['primary-vision-model'],
          discrepancies: [],
          confidence: 95,
        };
      }

      const prompt = 'Synthesize a consensus analysis from multiple independent vision model outputs. Identify agreed facts and list any discrepancies or hallucinations. '
        + 'Outputs:\n' + descs.map((d, i) => 'Model ' + (i + 1) + ' (' + d.model + '):\n' + d.desc).join('\n\n')
        + '\n\nReply with strict JSON {"consensus":"synthesized accurate description of agreed facts","discrepancies":["point of disagreement 1"],"confidence":number(0-100)}.';

      const { description: syn } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(syn.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}

      return {
        consensus: String(parsed?.consensus || syn || descs[0].desc),
        modelsQueried,
        discrepancies: Array.isArray(parsed?.discrepancies) ? parsed.discrepancies.map(String) : [],
        confidence: Number(parsed?.confidence ?? 90),
      };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_memory_search',
    description: 'Search previously attached or processed images in session memory by semantic description or keywords.',
    parameters: {
      query: { type: 'string', description: 'Search query (e.g. "diagram with database", "receipt with 1500 total", "beagle dog")' },
      limit: { type: 'number', description: 'Maximum number of results to return (default 5)', default: 5 },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string' },
                name: { type: 'string' },
                score: { type: 'number' },
                descriptionSnippet: { type: 'string' },
              },
            },
          },
        },
      },
      render(_a, v) {
        if (!v.matches || v.matches.length === 0) return [{ type: 'text', text: 'No matching images found in visual memory.' }];
        const text = v.matches.map((m, i) => (i + 1) + '. **' + m.name + '** (ID: `' + m.attachmentId + '`, Match: ' + Math.round(m.score * 100) + '%)\n   ' + m.descriptionSnippet).join('\n\n');
        return [{ type: 'text', text: 'Found ' + v.count + ' matching images in visual memory:\n\n' + text }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 15000,
    execute: async ({ query, limit }) => {
      const q = String(query || '').toLowerCase().trim();
      if (!q) throw new Error('vision_memory_search: query is required');
      const maxResults = limit || 5;
      const terms = q.split(/\s+/).filter(t => t.length > 2);

      const candidates = [];
      for (const [id, ref] of attachmentById.entries()) {
        const name = String(ref?.name || id);
        // #229: score each attachment against ITS OWN description — the old
        // loop concatenated every cached description into every candidate, so
        // all attachments scored identically.
        const own = descriptionByAttachmentId.get(String(id));
        const text = (name + ' ' + (typeof own === 'string' ? own : '')).toLowerCase();

        let score = 0;
        if (text.includes(q)) score += 0.8;
        for (const t of terms) {
          if (text.includes(t)) score += 0.2;
        }

        if (score > 0) {
          const descMatch = text.slice(0, 160) + '...';
          candidates.push({
            attachmentId: String(id),
            name,
            score: Math.min(1.0, score),
            descriptionSnippet: descMatch,
          });
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      const matches = candidates.slice(0, maxResults);
      return {
        count: matches.length,
        matches,
      };
    },
  }))

ctx.tools.register(defineTool({
    name: 'vision_audit_accessibility',
    description: 'Audit UI screenshots for WCAG 2.1 accessibility, color contrast ratios, text readability, and touch target sizes.',
    parameters: {
      attachmentId: { type: 'string', description: 'Attachment ID or file path' },
      path: { type: 'string', description: 'Local file path' },
      standard: { type: 'string', enum: ['WCAG_AA', 'WCAG_AAA', 'all'], default: 'WCAG_AA', description: 'Accessibility compliance standard' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          score: { type: 'number' },
          passed: { type: 'boolean' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string' },
                severity: { type: 'string' },
                element: { type: 'string' },
                description: { type: 'string' },
                recommendation: { type: 'string' },
              },
            },
          },
        },
      },
      render(_a, v) {
        const issuesText = (v.issues || []).map((i) => '[' + i.severity.toUpperCase() + '] ' + i.element + ': ' + i.description + '\n -> Recommendation: ' + i.recommendation).join('\n\n');
        return [{ type: 'text', text: 'WCAG Score: ' + v.score + '/100 (' + (v.passed ? 'PASSED' : 'FAILED') + ')\n\n' + issuesText }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs + 20000,
    execute: async ({ attachmentId, path, standard }, exec) => {
      const src = await resolveSourceBytes(null, attachmentId, path);
      if (!src) throw new Error('vision_audit_accessibility: image source not found');
      const std = standard || 'WCAG_AA';
      const prompt = 'Audit this UI screenshot against ' + std + ' accessibility guidelines. Check text contrast ratios against backgrounds, minimum font sizes, touch target areas, icon clarity, and visual hierarchy. '
        + 'Reply with strict JSON {"score":number(0-100),"passed":boolean,"issues":[{"type":"contrast|font_size|target_size|clarity","severity":"critical|warning|info","element":"button/header/text name","description":"issue description","recommendation":"how to fix"}]}.';
      const { description } = await callVisionModelWithBytes(src.bytes, src.contentType, prompt, { ...(exec ? { signal: exec.signal } : {}) });
      let parsed = null;
      try { parsed = JSON.parse(description.match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
      const issues = Array.isArray(parsed?.issues)
        ? parsed.issues.map((i) => ({
            type: String(i.type || 'contrast'),
            severity: String(i.severity || 'warning'),
            element: String(i.element || 'UI element'),
            description: String(i.description || ''),
            recommendation: String(i.recommendation || ''),
          }))
        : [];
      return {
        score: Number(parsed?.score ?? 85),
        passed: Boolean(parsed?.passed ?? (issues.filter((i) => i.severity === 'critical').length === 0)),
        issues,
      };
    },
  }))

}
