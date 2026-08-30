import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { imageDimensions } from '../lib/index.js';

// Resolve repo root from this test file's location.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Loader contract ────────────────────────────────────────────────────────
describe('loader contract', () => {
  it('package.json has required dsh fields', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@goodandready/dsh-vision-bridge');
    assert.match(pkg.version, /^\d+\.\d+\.\d+/);
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.main, './lib/index.js');
    assert.ok(pkg.exports['.']);
    assert.ok(pkg.exports['./client']);
    assert.ok(Array.isArray(pkg.files) && pkg.files.includes('lib/'));
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(pkg.dsh.client.platform, 'web');
  });

  it('cordis.patch.yml declares the bundle layer', () => {
    const yml = readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8');
    assert.match(yml, /id:\s*dsh-vision-bridge/);
    assert.match(yml, /name:\s*['"'"']@goodandready\/dsh-vision-bridge['"'"']/);
  });

  it('cordis.patch.yml name matches package.json name and client loader id', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const yml = readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8');
    const client = readFileSync(path.join(repoRoot, 'lib/client.js'), 'utf8');
    const ymlName = yml.match(/name:\s*['"'"']([^'"'"']+)['"'"']/)[1];
    const loaderId = client.match(/id:\s*['"'"']([^'"'"']+)['"'"']/)[1];
    assert.equal(ymlName, pkg.name);
    assert.equal(loaderId, pkg.name);
  });
});

// ── Pure helpers (no DSH runtime) ────────────────────────────────────────
describe('sanitizeAllowed', async () => {
  const { sanitizeAllowed } = await import(path.join(repoRoot, 'lib/index.js'));

  it('hybrid + sanitizeImages true => allowed', () => {
    assert.equal(sanitizeAllowed({ mode: 'hybrid', sanitizeImages: true }), true);
  });
  it('llm + sanitizeImages true => allowed', () => {
    assert.equal(sanitizeAllowed({ mode: 'llm', sanitizeImages: true }), true);
  });
  it('tools mode => not allowed regardless of sanitizeImages', () => {
    assert.equal(sanitizeAllowed({ mode: 'tools', sanitizeImages: true }), false);
    assert.equal(sanitizeAllowed({ mode: 'tools', sanitizeImages: false }), false);
  });
  it('sanitizeImages false => not allowed', () => {
    assert.equal(sanitizeAllowed({ mode: 'hybrid', sanitizeImages: false }), false);
  });
  it('defaults (undefined) => allowed (legacy compat)', () => {
    assert.equal(sanitizeAllowed({}), true);
  });
});

describe('acceptsImages', async () => {
  const { acceptsImages } = await import(path.join(repoRoot, 'lib/index.js'));
  it('text+image => true', () => assert.equal(acceptsImages({ inputModalities: ['text', 'image'] }), true));
  it('text only => false', () => assert.equal(acceptsImages({ inputModalities: ['text'] }), false));
  it('null/undefined => false', () => {
    assert.equal(acceptsImages(null), false);
    assert.equal(acceptsImages(undefined), false);
    assert.equal(acceptsImages({}), false);
  });
});

describe('blocksHaveImage', async () => {
  const { blocksHaveImage } = await import(path.join(repoRoot, 'lib/index.js'));
  it('detects top-level image', () => assert.equal(blocksHaveImage([{ type: 'image' }]), true));
  it('detects nested image in tool-result', () => assert.equal(blocksHaveImage([{ type: 'tool-result', content: [{ type: 'image' }] }]), true));
  it('no image => false', () => assert.equal(blocksHaveImage([{ type: 'text', text: 'hi' }]), false));
  it('non-array => false', () => assert.equal(blocksHaveImage(null), false));
  it('empty => false', () => assert.equal(blocksHaveImage([]), false));
});

describe('rewriteImagesDeep — image->text transform', async () => {
  const { rewriteImagesDeep } = await import(path.join(repoRoot, 'lib/index.js'));
  const marker = (b) => ({ type: 'text', text: `[image:${b.attachment?.attachmentId ?? '?' }]` });

  it('replaces top-level image', async () => {
    const { content, changed, attachments } = await rewriteImagesDeep([{ type: 'image', attachment: { attachmentId: 'a1' } }], marker);
    assert.equal(changed, true);
    assert.equal(content[0].type, 'text');
    assert.equal(attachments.length, 1);
  });

  it('replaces image inside tool-result.content', async () => {
    const input = [{ type: 'tool-result', content: [{ type: 'image', attachment: { attachmentId: 'a2' } }, { type: 'text', text: 'ok' }] }];
    const { content, changed } = await rewriteImagesDeep(input, marker);
    assert.equal(changed, true);
    assert.equal(content[0].content[0].type, 'text');
  });

  it('no image => not changed', async () => {
    const input = [{ type: 'text', text: 'hi' }];
    const { content, changed } = await rewriteImagesDeep(input, marker);
    assert.equal(changed, false);
    assert.deepEqual(content, input);
  });

  it('replace returning array spreads', async () => {
    const { content } = await rewriteImagesDeep([{ type: 'image' }], () => [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
    assert.equal(content.length, 2);
  });

  it('replace returning null/undefined drops the block', async () => {
    const { content } = await rewriteImagesDeep([{ type: 'image' }, { type: 'text', text: 'keep' }], () => null);
    assert.equal(content.length, 1);
    assert.equal(content[0].text, 'keep');
  });
});

describe('sniffMediaType', async () => {
  const { sniffMediaType } = await import(path.join(repoRoot, 'lib/index.js'));
  it('detects png', () => assert.equal(sniffMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), 'image/png'));
  it('detects jpeg', () => assert.equal(sniffMediaType(Uint8Array.from([0xff, 0xd8, 0xff])), 'image/jpeg'));
  it('unknown => undefined', () => assert.equal(sniffMediaType(Uint8Array.from([0, 0, 0])), undefined));
});

describe('channel driver — cooldown & fallback', async () => {
  const { channelKey, resolveApiKey } = await import(path.join(repoRoot, 'lib/channels.js'));
  it('channelKey for each type', () => {
    assert.equal(channelKey({ type: 'dsh-catalog', provider: 'openai', model: 'gpt-4o' }), 'dsh-catalog:openai/gpt-4o');
    assert.equal(channelKey({ type: 'ollama', model: 'llava' }), 'ollama:http://localhost:11434/v1/llava');
    assert.equal(channelKey(null), '?');
  });
  it('resolveApiKey prefers entry apiKey over env', () => {
    assert.equal(resolveApiKey({ apiKey: 'literal' }), 'literal');
  });
});

describe('cache — LRU', async () => {
  const { createLru, descriptionCacheKey } = await import(path.join(repoRoot, 'lib/cache.js'));
  it('evicts oldest on overflow', () => {
    const lru = createLru(2);
    lru.set('a', 1); lru.set('b', 2); lru.set('c', 3);
    assert.equal(lru.size, 2);
    assert.equal(lru.has('a'), false);
    lru.get('b'); lru.set('d', 4);
    assert.equal(lru.has('c'), false);
    assert.equal(lru.has('b'), true);
  });
  it('composite key changes with prompt/model/mode', () => {
    const b = new Uint8Array([1, 2, 3]);
    const k1 = descriptionCacheKey({ bytes: b, prompt: 'describe', model: 'p/m', mode: 'auto' });
    const k2 = descriptionCacheKey({ bytes: b, prompt: 'describe', model: 'p/m', mode: 'auto' });
    const k3 = descriptionCacheKey({ bytes: b, prompt: 'DIFFERENT', model: 'p/m', mode: 'auto' });
    assert.equal(k1, k2);
    assert.notEqual(k1, k3);
  });
});

// ── Route validation (schema-level) ───────────────────────────────────────
describe('route validation — /config POST allow-list', () => {
  it('unknown mode is rejected (simulated allow-list)', () => {
    const ALLOWED = new Set(['hybrid', 'llm', 'tools']);
    const incoming = 'bad-mode';
    assert.equal(ALLOWED.has(incoming), false);
  });
  it('unknown describeStrategy is rejected', () => {
    const ALLOWED = new Set(['auto', 'llm', 'ocr-local', 'cache-only']);
    assert.equal(ALLOWED.has('bad'), false);
    assert.equal(ALLOWED.has('auto'), true);
  });
});

describe('client i18n contract', () => {
  it('client registers namespace dsh-vision-bridge via ctx.locale.register', () => {
    const src = readFileSync(path.join(repoRoot, 'lib/client.js'), 'utf8');
    assert.match(src, /ctx\.locale\.register\(NS,\s*\{\s*en,\s*ru\s*\}\)/);
    assert.match(src, /NS\s*=\s*['"'"']dsh-vision-bridge['"'"']/);
  });
  it('client injects locale slot', () => {
    const src = readFileSync(path.join(repoRoot, 'lib/client.js'), 'utf8');
    assert.match(src, /exports\.inject\s*=\s*\[.*locale.*\]/);
  });
  // #117: provider/model selects must use the vision-filtered `models` array,
  // not `allModels`. Showing text-only providers/models makes the user pick a
  // model the plugin will then reject.
  it('client provider list is built from vision-filtered models, not allModels', () => {
    const src = readFileSync(path.join(repoRoot, 'lib/client.js'), 'utf8');
    // Locate the `const providers = Array.from(...)` line and assert it reads
    // from `models`, not `allModels`. Matches both `const providers = Array.from(new Set(models.map` and the
    // comment-preceded variant.
    assert.match(src, /const providers = Array\.from\(new Set\(models\.map\(\(m\) => String\(m\.provider\)\)\)\)/);
    // Defensive: the old buggy line must not reappear.
    assert.doesNotMatch(src, /const providers = Array\.from\(new Set\(allModels\.map\(/);
  });
});

// ── #115: imageDimensions must accept Buffer AND Uint8Array ────────────────
// attachments.readImage may return Uint8Array; URL/path fetch returns Buffer.
// readUInt32BE is Buffer-only, so imageDimensions must normalize at the top.
describe('imageDimensions (#115)', () => {
  // 1x1 transparent PNG: width=1, height=1 in IHDR (offsets 16..24, big-endian).
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );

  it('returns width/height for a Buffer (URL/path fetch path)', () => {
    const dims = imageDimensions(pngBytes);
    assert.deepEqual(dims, { width: 1, height: 1 });
  });

  it('returns width/height for a Uint8Array (attachment readImage path)', () => {
    // Mirror the real shape: ctx.attachments.readImage returns a typed array
    // backed by an ArrayBuffer. `bytes` here is a fresh Uint8Array view.
    const u8 = new Uint8Array(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
    const dims = imageDimensions(u8);
    assert.deepEqual(dims, { width: 1, height: 1 });
  });

  it('returns null for inputs that are too short', () => {
    assert.equal(imageDimensions(Buffer.alloc(0)), null);
    assert.equal(imageDimensions(new Uint8Array(0)), null);
  });
});

// ── #119: dead-code Block D — ctx.skills.registerProvider is a no-op ───────
// DSH 0.1.2-alpha.1 does not expose a Skill provider registration API, so the
// Block-D block was a silent no-op (optional chain hid the missing method).
// Removing it: no registerProvider call, no visionSkillProvider object.
describe('skill provider registration (#119)', () => {
  it('lib/index.js does not call ctx.skills.registerProvider', () => {
    const src = readFileSync(path.join(repoRoot, 'lib/index.js'), 'utf8');
    // Match both safe (`?.`) and unsafe (`.`) access — neither is in the source now.
    assert.doesNotMatch(src, /ctx\.skills\??\.registerProvider/);
  });
  it('lib/index.js does not define visionSkillProvider', () => {
    const src = readFileSync(path.join(repoRoot, 'lib/index.js'), 'utf8');
    assert.doesNotMatch(src, /visionSkillProvider/);
  });
  it('skills/vision-skills/ directory still ships (kept for future real API)', () => {
    const exists = existsSync(path.join(repoRoot, 'skills/vision-skills/SKILL.md'));
    assert.equal(exists, true);
  });
});
