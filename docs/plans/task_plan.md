# Task Plan: Fix Audit Security & Settings Issues (#190, #191, #192)

## Phase 1: Security & Route Guards (#192)
- [ ] Add `isTrustedSettingsRequest(req)` helper to `lib/index.js`.
- [ ] Guard `POST /config`, `POST /channels`, `POST /channels/test`, `POST /upload-pdf`.

## Phase 2: API Key Secret Masking (#190)
- [ ] Mask `apiKey` in `GET /channels` and `GET /config`.
- [ ] Do not overwrite existing `apiKey` with mask value on save in `POST /channels`.
- [ ] Support credential references (`keysFromEnv`).

## Phase 3: settingsScope Snapshot Binding (#191)
- [ ] Add `settingsScope` to `exports.inject` in `lib/client.js` and `package.json` (if required).
- [ ] Bind `ctx.settingsScope.bind({ namespace: 'dsh-vision-bridge' })` in `lib/client.js`.
- [ ] Sync settings card state with settingsScope snapshot.

## Phase 4: Testing & Verification
- [ ] Add tests in `test/regression.test.js` for all 3 issues.
- [ ] Run `npm test` and verify 100% pass rate.
- [ ] Commit, PR, merge, and clean up.
