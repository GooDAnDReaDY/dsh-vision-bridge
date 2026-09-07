# Task Plan: Refactor Stability & Async (#195)

## Phase 1: Async Non-blocking Execution
- [ ] Create async runner utility `runProcess(bin, args, options)` using non-blocking `execFile`/`spawn` with promise, timeout, and signal.
- [ ] Replace `spawnSync('pdftoppm', ...)` in `/upload-pdf` and `vision_pdf_pages` with async runner.
- [ ] Replace `spawnSync('tesseract', ...)` in `vision_ocr_local` and OCR fallback with async runner.
- [ ] Replace `spawnSync('ffmpeg', ...)` in `vision_video_describe` with async runner.
- [ ] Replace `spawnSync(chrome, ...)` in `vision_html_screenshot` / `vision_page_persist` with async runner.

## Phase 2: Tool Registry Deduplication & Cleanup
- [ ] Collapse `vision_math_extract` into `vision_extract_formula` (keep backwards compatibility).
- [ ] Collapse `vision_qr_read` into `vision_scan_barcode`.
- [ ] Collapse `vision_describe_structured` into `vision_extract_structured`.
- [ ] Collapse `vision_diff` / `vision_pixel_diff` into `vision_compare`.
- [ ] Remove dead stubs `vision_browser_click` and `vision_browser_navigate` (clean up prompt bloat).
- [ ] Ensure all aliases and unified tools have clean schemas and descriptions.

## Phase 3: Modular Code Organization
- [ ] Create `lib/process.js` for async binary executions (Tesseract, pdftoppm, ffmpeg, chrome).
- [ ] Keep `lib/index.js` clean and maintainable.

## Phase 4: Testing & Verification
- [ ] Run full regression test suite (`npm test`).
- [ ] Verify non-blocking async execution in automated tests.
- [ ] Verify tool contracts and deduplicated tools.
