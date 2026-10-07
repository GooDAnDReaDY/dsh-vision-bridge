# Changelog

## 0.6.15

### Bug Fixes & Improvements
- **Channel Pipeline, Routing, Resilience & Cancellation (Block 5)**:
  - **Host LLM Stream Dispatcher for dsh-catalog Channels** (#386): Implemented `dsh-catalog` channel driver in `lib/channels.js` to dispatch images and prompts via `ctx.llm.stream` with `VISION_PASS`, enabling native catalog models to function seamlessly within sequential, parallel-race, and consensus pipelines.
  - **Unified Pipeline Routing for describe_image & VQA** (#387): Eliminated the split path in `describe_image` that bypassed `callVisionModelWithBytes` for non-generic questions, routing all image attachments through configured channels, image preprocessing, privacy masking, and circuit breaker policies. Routed `vision_vqa` through `callVisionModelWithBytes` and added `VISION_PASS` to `vision_compare` to prevent recursive stream interception.
  - **Circuit Breaker & Auto-Latency State Persistence** (#388): Passed host persistent `channelCircuitStates` and `channelLatencies` maps into `runChannels`, ensuring circuit breaker failures/recoveries and latency measurements persist across calls and are visible to `GET /dsh-vision-bridge/circuit` and auto-latency sorting. Added `DELETE /dsh-vision-bridge/circuit` endpoint to reset breaker states.
  - **Batch Cancellation & Lifecycle Cleanup** (#397): Connected `exec.signal` and batch lifetime to `AbortController` in `vision_batch`, ensuring aborted execution signals fail immediately before launching work. Ensured `DELETE /dsh-vision-bridge/batch/:id` aborts active provider streams and controllers immediately. Added `ctx.effect` unload disposer cancelling in-flight batches.
  - **Evidence Store Debounce & Clean Shutdown Persistence** (#398): Added `flushSync()` and `dispose()` methods to `EvidenceStore` and registered `beforeExit`/`exit` process handlers and `ctx.effect` unload disposer, ensuring debounced persistence writes are flushed to disk on service restart, reload, or CLI exit.
  - **Truthful Contract for vision_scan_barcode** (#405): Aligned `vision_scan_barcode` tool description and execution contract with actual visual model inspection reality, eliminating misleading "without VLM overhead" claims. Guaranteed truthful `{ found: false, codes: [] }` responses when no codes are detected.

## 0.6.14

### Bug Fixes & Improvements
- **Output Schemas, Truthfulness & Security Trust (Block 4)**:
  - **Security Trust Check Hardening** (#375): Hardened `isTrustedSettingsRequest` in `lib/vision-core.js` by disallowing external network callers with spoofed `sec-fetch-site: same-origin` headers from bypassing authentication without a valid token.
  - **Strict Tool Output Schemas** (#385): Updated `vision_diff` output schema to declare `warnings`, `parseWarning`, and `raw`, and normalized `differences` items strictly according to schema. Added `warnings` to `vision_consensus` output schema with consistent array return across all branches. Fixed `checkImageQuality` to return `blur: 'unknown'` (string) instead of `blur: 0` (number) and `score: 0` on errors or when sharp is unavailable.
  - **Truthful Evaluation & Indeterminate Fallbacks** (#394): Fixed `vision_audit_accessibility` and `vision_verify_generated_image` to return `score: 0, passed: false` with explanatory warnings when vision model responses are invalid or non-JSON, preventing false-positive PASS85/90 verdicts. Enforced strict boolean parsing for `"false"` strings. Ensured `vision_consensus` reports `confidence: 0` and records discrepancies when available channels do not meet `minAgreement`.
  - **Diagnostic Test Truthfulness** (#396): Ensured `callVisionModelWithBytes` returns `ok: false` and failure details when all channels fail in placeholder mode. Added `noCache: true` support for active diagnostics so test probes never receive cached responses. Updated `POST /dsh-vision-bridge/test` to report `ok: false` and error descriptions instead of false-positive `ok: true`.
  - **Test Harness Modernization** (#401): Updated `test/harness.js` to model modern DSH 0.2 environments without retired `settings.register`, added strict tool output schema validation, and added `test/settings-contract.test.js` verifying settings contracts and schema conformance across all registered tools.

## 0.6.13

### Bug Fixes & Improvements
- **Cache Identity, Bbox Normalization & Quality Metrics (Block 3)**:
  - **Cache Identity & Null Safety** (#377, #378): Prevented `pHash` cache cross-contamination on identical images by generating perceptual cache keys incorporating prompt, model, mode, and promptVersion (`pHashKeyFor`). Guarded against null references in `descriptionByHash` when `config.cacheEnabled === false`.
  - **Vision Crop Parsing & Attachment Cap** (#390, #409): Corrected numeric region parsing regex in `vision_crop` from `^s*\[?s*d` to `^\s*\[?\s*-?\d`, preventing unnecessary VLM grounding and rejecting invalid coordinates. Routed crop and annotate attachments through `recordAttachment()` to enforce the 300-entry capacity limit and prevent memory leaks.
  - **Bbox Normalization Consistency** (#391): Removed dimension-based heuristics (>1000px vs <=1000px) and axis-swapping in `normalizeBbox()`. Standardized 0..1000 and 0..1 scale preservation across arbitrary resolutions with explicit pixel unit support.
  - **Pixel Diff Alpha & Tolerance 0** (#392): Factored alpha channel differences (`da`) into pixel comparison. Honored explicit `tolerance: 0` without fallback to default 30. Fixed dimension mismatch counts to maintain consistent `totalPixels` and `diffPixels`, stripping undeclared schema properties.
  - **Optimizer Auto Format & Deterministic Quality** (#393, #395): Fixed undeclared `auto` variable in `smartOptimizeImage()` image compression options. Enhanced `analyzeImageQuality()` to perform genuine decoding (PNG or via sharp for other supported formats) and throw on corrupt/invalid input instead of fabricating constant 50/50/100 fake metrics with undeclared note properties.


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
