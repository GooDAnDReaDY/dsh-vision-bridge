# Task Plan — Issue #222: Settings Card & Client Audit

## 1. Objectives
- Fix unsafe dictionary registration (`ctx.locale.register`) in `lib/client.js` with `try / catch` to ensure client half never crashes on reload/double apply.
- Remove redundant `settings.section` fallback from `lib/client.js` and keep only `settings.plugin.item`.
- Safely access DSH services via `ctx.get('...')` instead of raw property access on context proxies (`ctx.settings`, `ctx.llm`, `ctx.locale`, `ctx.slots`).
- Audit and document settings card fields vs Config schema (45 fields), ensuring critical settings are configurable and non-UI parameters are documented.
- Add comprehensive regression tests in `test/ux.test.js` or `test/regression.test.js`.

## 2. Phases
- [ ] Phase 1: Research & Audit (`lib/client.js`, `lib/index.js`, `lib/vision-core.js`).
- [ ] Phase 2: Implementation of client fixes (`lib/client.js` safe locale, no `settings.section`, safe `ctx.get`).
- [ ] Phase 3: Backend & Schema audit (`lib/index.js` `/config` endpoint synchronization, safe service access).
- [ ] Phase 4: Test Suite & Verification (`test/ux.test.js`, `npm test`).
- [ ] Phase 5: Gitea PR, merge to main, worktree cleanup, and release gate.
