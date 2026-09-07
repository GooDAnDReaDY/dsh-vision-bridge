# Findings: Stability & Architecture Review

1. **Synchronous Process Spawning**:
   Calls to `spawnSync` for `pdftoppm`, `tesseract`, `ffmpeg`, and `chrome` ran synchronously on the main Node.js thread, freezing the event loop during large file processing.
   Solution: A dedicated `runProcess` async helper wrapped in Promise with `AbortSignal` and configurable `timeoutMs`.

2. **Tool Catalog Optimization**:
   46 tools in the catalog caused ~4k tokens overhead per turn.
   Deduplicating identical/overlapping tools and eliminating empty stubs streamlines the system prompt while maintaining 100% of capabilities.

3. **Backwards Compatibility**:
   Retaining tool aliases where necessary ensures existing scripts and workflows remain fully functional.
