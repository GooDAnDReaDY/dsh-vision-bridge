# Findings — Issue #222

## 1. Locale Registration
- `ctx.effect(() => ctx.locale.register(NS, { en }), 'dsh-vision-bridge: dictionaries')` in `lib/client.js:815` was called without a `try/catch`. On double execution or existing registration, throwing an error crashed the entire client bundle.
- Fix: Wrap `ctx.locale?.register?.(...)` inside try/catch with `console.warn`.

## 2. Redundant Top-Level Sidebar Section
- `lib/client.js` registered `settings.section` as a fallback if `tryPluginItem()` failed.
- According to DSH plugin authoring standards, plugin settings belong in `settings.plugin.item` card and must not pollute the top-level settings sidebar.
- Fix: Register `settings.plugin.item` directly and delete `settings.section`.

## 3. Service Property Access
- `ctx.locale` in client and `ctx.llm` / `sctx.settings` in server were accessed as direct properties.
- Context proxies in Cordis can return `undefined` for class properties when methods or scoped access are expected.
- Fix: Use `(ctx.get ? ctx.get('locale') : ctx.locale)` / `(ctx.get ? ctx.get('slots') : ctx.slots)` / `(ctx.get ? ctx.get('llm') : ctx.llm)`.

## 4. Settings Card vs Schema
- Schema has 45 fields in `lib/vision-core.js`.
- Core user-facing options (Vision Provider/Model, Mode, Describe Strategy, Escalation, Native Passthrough, Channel Order, Latency Fallbacks, Preprocessing, Privacy/Masking, Self-Check, Consensus, URL host boundaries) are exposed via `/config` and `/channels` API and UI controls.
- Advanced internal parameters (`maxImageBytes`, `keysFromEnv`, `timeoutMs`, `evidenceDir`) have sensible defaults in the schema and are documented.
