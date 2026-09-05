# Findings: Audit 2026-09-05 (#190, #191, #192)

1. **#190 (apiKey exposure)**:
   `GET /channels` directly returned channel JSON which included `channel.apiKey`. In web apps this exposes stored provider keys in DevTools/XHR. Fix: return masked string (e.g. `sk-...****`) or `hasApiKey: true`. When receiving POST with mask string, keep the previously configured key.

2. **#191 (settingsScope)**:
   In modern DSH, `ctx.settingsScope` manages settings snapshots and persistence. The client was doing standalone `fetch('/dsh-vision-bridge/config')` without notifying the kernel scope. Adding `settingsScope` to `exports.inject` and binding the namespace integrates cleanly.

3. **#192 (isTrustedSettingsRequest)**:
   DSH standards require mutating HTTP endpoints to verify `request.headers['sec-fetch-site'] !== 'cross-site'` to block cross-origin CSRF invocations.
