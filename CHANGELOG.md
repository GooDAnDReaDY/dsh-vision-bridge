# Changelog

Notable changes to `@goodandready/dsh-vision-bridge`.

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
