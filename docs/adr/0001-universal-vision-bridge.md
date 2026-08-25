# 0001 — Universal vision bridge

## Status

Accepted (0.3.x).

## Context

Text-only DeepSeek models fail turns with `UNSUPPORTED_CONTENT` on image blocks.
Replace `dsh-vision-router` with a self-owned bridge: auto-rewrite image→text for
text-only models, plus explicit vision tools.

## Decision

- Two-halves cordis plugin, `@goodandready/dsh-vision-bridge`.
- Auto-rewrite at `agent/pre-step` + `llm/stream`, gated by `mode` and
  `nativePassthrough`.
- Tools use the same channel driver as auto-rewrite (no second backend).
- Multi-channel endpoints with sequential/parallel-race + cooldown + placeholder.
- Settings in a collapsible Plugins-tab card (`settings.plugin.item`), fallback to
  sidebar `settings.section`.
- No heavy native deps (sharp rejected): crop stays bbox-only; `html_screenshot`/
  `video_describe` use Chrome/ffmpeg only when present.

## Consequences

- Defaults preserve 0.1.x behavior.
- Users must add `sharp: true` to `allowBuilds` for any future sharp feature — so
  it was deferred rather than forced.
