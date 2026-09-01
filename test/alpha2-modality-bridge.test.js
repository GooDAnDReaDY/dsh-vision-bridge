import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { acceptsImages, apply, Config } = await import(path.join(repoRoot, 'lib/index.js'));

describe('acceptsImages', () => {
  it('returns true when model natively supports images', () => {
    assert.equal(acceptsImages({ inputModalities: ['text', 'image'] }), true);
  });

  it('returns false when model natively only supports text', () => {
    assert.equal(acceptsImages({ inputModalities: ['text'] }), false);
  });

  it('returns false when model is bridged (_nativeInputModalities is text-only)', () => {
    assert.equal(acceptsImages({
      inputModalities: ['text', 'image'],
      _nativeInputModalities: ['text'],
    }), false);
  });

  it('returns true when model is bridged and natively supported images', () => {
    assert.equal(acceptsImages({
      inputModalities: ['text', 'image'],
      _nativeInputModalities: ['text', 'image'],
    }), true);
  });
});

describe('LLM modality bridge lifecycle', () => {
  it('augments resolveModelInfo and listModels when sanitizeAllowed is true', async () => {
    const cleanups = [];
    const fakeCtx = {
      effect(fn) {
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
        return cleanup;
      },
      on() {},
      inject(services, fn) {
        fn({
          settings: { register: () => ({ get: () => ({}) }) },
          effect(f) {
            const c = f();
            if (typeof c === 'function') cleanups.push(c);
            return c;
          },
        });
      },
      tools: { register() {} },
      webServer: { register() {} },
      llm: {
        async resolveModelInfo(provider, model) {
          if (model === 'text-only') {
            return { provider, id: model, inputModalities: ['text'] };
          }
          return { provider, id: model, inputModalities: ['text', 'image'] };
        },
        async listModels(provider) {
          return [
            { provider, id: 'text-only', inputModalities: ['text'] },
            { provider, id: 'multimodal', inputModalities: ['text', 'image'] },
          ];
        },
      },
    };

    const origResolve = fakeCtx.llm.resolveModelInfo;
    const origList = fakeCtx.llm.listModels;

    const fullConfig = Config({ mode: 'hybrid', sanitizeImages: true, timeoutMs: 120000 });
    apply(fakeCtx, fullConfig);

    // 1. Check resolveModelInfo on text-only model
    const textInfo = await fakeCtx.llm.resolveModelInfo('prov', 'text-only');
    assert.deepEqual(textInfo.inputModalities, ['text', 'image']);
    assert.deepEqual(textInfo._nativeInputModalities, ['text']);
    assert.equal(acceptsImages(textInfo), false, 'acceptsImages should know it needs bridging');

    // 2. Check resolveModelInfo on native multimodal model
    const multiInfo = await fakeCtx.llm.resolveModelInfo('prov', 'multimodal');
    assert.deepEqual(multiInfo.inputModalities, ['text', 'image']);
    assert.equal(multiInfo._nativeInputModalities, undefined);
    assert.equal(acceptsImages(multiInfo), true);

    // 3. Check listModels
    const models = await fakeCtx.llm.listModels('prov');
    assert.equal(models.length, 2);
    assert.deepEqual(models[0].inputModalities, ['text', 'image']);
    assert.deepEqual(models[0]._nativeInputModalities, ['text']);
    assert.deepEqual(models[1].inputModalities, ['text', 'image']);

    // 4. Test cleanup / effect disposal
    for (const dispose of cleanups) dispose();
    assert.equal(fakeCtx.llm.resolveModelInfo, origResolve);
    assert.equal(fakeCtx.llm.listModels, origList);
  });
});