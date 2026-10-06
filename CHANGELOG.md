# Changelog

## 0.6.12

### Security & Hardening
- **Session Isolation & Security Boundaries (Block 2)**:
  - **Path Normalization & Directory Containment** (#373, #369, #376): Fixed boundary checks in `isPathAllowed` to normalize target paths and allowed directory boundaries, preventing traversal bypasses (`/allowed/dir/../../../../etc/passwd`). Added canonical `resolveInside(baseDir, candidatePath)` helper enforcing strict lexical containment and realpath ancestor/target bounds. Secured `vision_export_artifact` in `lib/tools/document.js` against path traversal and outside-workspace writes.
  - **FS Boundaries & Permission Enforcement** (#380, #381): Moved `allowedImageDirs` check in `resolveSourceBytes()` ahead of DSH `fs` probe so unauthorized paths are not resolved or read by host services. Added `allowedImageDirs` validation to `vision_present`. Removed unsafe `node:fs` bypass in `vision_materialize` when `fs.writeBytes` fails or rejects.
  - **Session & Agent Isolation** (#379): Implemented `SessionScopedAttachmentMap` and `extractSessionId()` helper to scope `attachmentById`, `descriptionByAttachmentId`, and `lastUserText` per agent session. Ensured missing-source lookups in `vision_inspect` and `describe_image` never leak attachments across agent sessions.
  - **Channel Env Keys Resolution** (#382): Constrained API key resolution to configured `config.keysFromEnv` across all channel drivers (`runChannels`, `runChannel`, `runOpenAIChat`, `runCustom`, `runWebhook`, `runVLLM`), and restricted `resolveChannelApiKey()` and `liveChannels()` to authorized environment keys only.
  - **Robust PNG Decoder & TypedArray Preprocessing** (#383, #384): Added full support for PNG `colorType === 4` (grayscale with alpha), validated bit depth (8) and color types (0, 2, 4, 6), enforced scanline length checks, and guarded against decompression bombs (>50MP) in `decodePng()`. Enabled `Uint8Array` support in `smartOptimizeImage()`, `decodePng()`, and `encodePng()`, ensuring DSH `fs.readBytes()` outputs undergo deskewing, resizing, and EXIF stripping without dropping optimizations.


## 0.6.11

### Fixed
- **Settings & Channels Persistence (Block 1)**:
  - **Volatile Box Unwrapping** (#372, #368): Wrapped configuration in `apply()` and `resolveStorageDir()` with a proxy unboxing volatile Schemastery objects while preserving in-place mutations, correctly evaluating boolean switches (`consensusEnabled`, `selfCheckEnabled`), `keysFromEnv`, and `evidenceDir`.
  - **Modern DSH Settings Service Adaptation** (#363, #370, #371): Adapted to modern DSH settings service (`describe()`, `update()`, `replace()`), removing reliance on removed `settings.register()`. Ensured `requireScope()` never throws (providing in-memory fallback) and removed unreachable return statement in `getLiveConfig()`.
  - **Dynamic GET /config Defaults** (#411): Refactored `GET /config` endpoint to derive response defaults dynamically from the `Config` schema, eliminating ~25 hardcoded duplicate local variables and drift.
  - **Channels Settings Persistence** (#374, #410): Added persistence to settings scope on `POST /channels` and `POST /config`, ensuring customized channel configurations survive DSH restarts. Restored unmasked API keys during round-trips with masked keys from the settings UI, and updated `liveChannels()` to query dynamic live configuration.

## 0.6.9

### Fixed
- **Peer gate on DSH 0.2.0-rc.1** (#58): DSH skips a profile bundle whose `peerDependencies` exclude the running version, so this plugin was absent from the profile with no error in the UI. Every `@deepseek-ai/dsh-*` peer now names both the 0.1.7-rc.2 and 0.2.0-rc.1 lines, because semver does not admit a prerelease of the next minor into a range that does not name it.

Notable changes to `@goodandready/dsh-vision-bridge`.

## 0.6.8

### Security
- **Strict Trusted Request Guard & Route Hardening**: Enforced loopback address verification (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) and Host header checks across all sensitive read routes (`/config`, `/channels`, `/models`, `/providers`, `/stats`, `/costs`, `/journal`, `/cache`, `/batch`, `/circuit`, `/telemetry`). Guarded `/doctor?probe=1` active ping probes from cross-site access, and enforced HTTP 405 Method Not Allowed on mutating endpoints (#308).
- **Non-Secret Quota Key Derivation**: Replaced raw 8-character API key prefix exposure with stable SHA-256 fingerprint labels (`key#<hash>` or `<ref>#<hash>`) across streaming and non-streaming channel completion events to eliminate credential leakage in quota telemetry (#358).
- **Bounded Request Body Reader**: Replaced unbounded request stream readers with `readBoundedBody()` enforcing strict size limits (512 KB for config/channel mutations, 1 MB for batch runs) and returning immediate HTTP 413 Payload Too Large on overflow to protect against denial of service (#359).

### Packaging
- **Release Tarball Footprint Cleanup**: Excluded internal `skills/` directory from npm package `files` allowlist, trimming distributed package from 38 to 29 production runtime files (#360).

## 0.6.7

### Fixed
- **Cordis Proxy Property Guard**: Wrapped `dataDir` probing in `resolveStorageDir` safely to prevent `cannot get property "dataDir" without inject` exception on plugin activation under strict Cordis contexts (#352).

## 0.6.6

### Fixed
- **UI Settings Row Seat & Bare Page Form**: Registered `plugins.row.config` first with canonical package key `@goodandready/dsh-vision-bridge#dsh-vision-bridge`, preserved `settings.plugin.item` as fallback, and added clean bare page rendering (`vbr-page`) (#335).
- **Core Reliability & Security Hardening**:
  - Declared `warnings` property in tool output schemas and sanitized `undefined` values for lossless JSON serialization (#340).
  - Enforced strict bearer token and session origin validation in `isTrustedSettingsRequest` (#349).
  - Rejected non-ok results in parallel race channel routing and added `AbortController` cancellation for losing requests (#341).
  - Connected `smartOptimizeImage` into the runtime pipeline and respected user deskew/enhance configuration (#342).
- **Storage & Journal Persistence**:
  - Silenced spurious `ENOENT` logs on fresh start when journal/evidence files do not yet exist, and properly resolved the DSH data directory (#352).
  - Made `EvidenceStore` and `VisionJournal` disk writes atomic via temporary file and rename, and unreferenced the flush timer to allow clean process termination (#347).
  - Resolved `npm audit` dependency vulnerabilities (#338).

### Performance
- **Channel Consensus Concurrency**: Switched multi-channel consensus queries from sequential execution to parallel fetching with `Promise.allSettled`, cutting consensus latency dramatically (#343).
- **Memory Bounds & LRU Eviction**:
  - Bounded `descriptionByAttachmentId` to 300 entries with LRU eviction to prevent memory leak on long-running daemons (#344).
  - Optimized `EvidenceStore` eviction from $O(N \log N)$ sorting to $O(1)$ natural Map insertion order (#347).
  - Cached `sharp` availability check across operations to prevent dynamic import thrashing on environments without optional native bindings (#346).
- **PDF Upload Roundtrip Optimization**: Eliminated multi-megabyte Base64 `dataUrl` payload and duplicate binary re-upload when importing PDF pages via `/upload-pdf` (#345).

### Removed
- Removed dead unused `_unused_makeT` function from `lib/client.js` (#348).

## 0.6.5

### Fixed
- Settings no longer wait on the removed settingsScope service. The client uses configForms (#350).

## 0.6.4

### Fixed
- **Settings reachable again on the plugin's own page**: the current DSH core
  (0.1.6-alpha.2) renders a plugin's configuration page only for entries registered
  in the plugin-list seat `plugins.item`. `VisionCard` (under its error boundary) is
  now registered there too (`id: 'dsh-vision-bridge'`, order 60, static label); the
  row seat and the legacy `settings.plugin.item` card stay as fallbacks.

## 0.6.3

### Fixed
- **Settings reachable again**: the card registered into `settings.plugin.item`, a
  slot the current DSH core (0.1.6-alpha.2) no longer renders, so the plugin's
  settings were unreachable. The surface now registers into the Plugins page row
  seat `plugins.row.config`, keyed `@goodandready/dsh-vision-bridge#dsh-vision-bridge`
  (`rowConfigKey(package, rowId)`): the plugin's row gains a configure control whose
  page is the settings form (`view: 'page'`, open and without our card header — the
  host page draws the title, icon, crumb and padding) plus a one-line state for
  `view: 'summary'`. The legacy seat stays registered as a fallback for older cores.

### Added
- This changelog.
