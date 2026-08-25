# dsh-vision-bridge

**Universal vision bridge** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a self-contained replacement for `dsh-vision-router`.

When the chat model has **no vision** (e.g. `deepseek-v4-flash`) and a message contains an image, the image never reaches the text-only model. Instead, the plugin picks **how** to handle it — depending on the configured **mode**:

- **`hybrid`** (default) — auto-rewrite image blocks into text descriptions using a vision model; tools stay available for explicit follow-ups. Identical to the legacy v0.1.x behavior.
- **`llm`** — auto-rewrite via vision model only (the text-only model never sees raw images); tools remain callable.
- **`tools`** — auto-rewrite is **off**. The text model must call `describe_image` (or another tool) explicitly, otherwise the adapter fails on the raw image. Useful when you want the model to decide *whether* to spend a vision call.

Plus, **multi-channel endpoints**: instead of routing through one DSH-catalog model, you can chain `dsh-catalog`, `openai-compatible`, `ollama`, and `custom` (template-based) endpoints — sequential fallback, per-channel cooldown, optional placeholder on total failure, and zero-config Ollama discovery.

- **`describe_image`** tool — ask the vision model about an image (attachment id or local path).
- **Description cache** — LRU by image bytes + prompt + model + mode. Same image, same prompt, same model → 0 network calls.
- **Settings → Vision** — pick the model, the mode, the strategy, the escalation policy, and the channels list. Test-vision button for live health checks.

## Install

```bash
# From npm:
dsh plugin --profile web add @goodandready/dsh-vision-bridge

# From GitHub:
dsh plugin --profile web add github:GooDAnDReaDY/dsh-vision-bridge

# Locally from a checkout:
dsh plugin --profile web add /path/to/dsh-vision-bridge
```

Restart the Web UI, open **Plugins → Settings → vision-bridge** (collapsible card).

## How it works

1. An image (from you or from a tool like `generate_image`) enters the chat and is shown by the UI.
2. **On every LLM request**, at two points:
   - `agent/pre-step`, which sees the messages claimed from the inbox — that is, the images **you** attach. Rewriting them here puts the description into the session history, so the model still remembers the image on later turns.
   - `llm/stream`, which sees the **whole outgoing request**. This is the net under everything else: a tool result is appended straight to the session and never passes through `pre-step`, so an image a tool produced would otherwise reach the adapter untouched and fail the turn with `does not support image input`.
3. **Mode gate** (`hybrid` / `llm` / `tools`) decides whether the rewrite runs at all. In `tools` mode the model must call `describe_image` itself.
4. **Channel selection**: `config.channels` is tried in order. If a channel returns 4xx/timeout/failure, it enters a 60s cooldown and the next channel is tried. With `autoLocalOllama: true` (default), `http://localhost:11434` is probed at startup and prepended when reachable.
5. **Vision model** produces a description. With `escalation: auto-escalate`, a complex image triggers a second deeper pass before substituting.
6. **Cache** (LRU 256 entries by default) is keyed by `sha256(bytes) + prompt + model + mode`. Same image + different prompt or model → cache miss (correct).
7. The text model reads text, not pixels. Turns never fail with `UNSUPPORTED_CONTENT`.
8. **`describe_image`** stays available for precise follow-ups.

## Settings

**Settings → Vision** (top-level section):

- **Mode** — `hybrid` / `llm` / `tools` (see above)
- **Describe strategy** — `auto` / `llm` / `ocr-local` / `cache-only`. `ocr-local` and `cache-only` are reserved for the v2.0 local-OCR backend.
- **Escalation** — `simple-only` (default, one pass) or `auto-escalate` (second deeper pass for complex images: dense text, code, UI, tables, charts)
- **Vision provider / model** — explicit override; empty = auto-pick first vision-capable model from the configured channels
- **Channels** — list of vision endpoints tried in order; type allow-list and field validation on save; per-channel status-dot for key presence
- **Test vision** — runs one real call against the current channel setup and reports `OK (NNNms)` or the failure reason

In `settings.yaml`:

```yaml
dsh-vision-bridge:
  # Mode (hybrid = legacy behavior; tools = no auto-rewrite)
  mode: hybrid

  # Strategy (auto = vision LLM; ocr-local / cache-only reserved for v2.0)
  describeStrategy: auto

  # Escalation (auto-escalate = second pass on complex images)
  escalation: simple-only

  # Legacy single-channel (dsh-catalog) shortcut — equivalent to channels: [{type: 'dsh-catalog', provider, model}]
  visionProvider: ""   # empty = auto-pick first vision-capable
  visionModel: ""      # empty = auto-pick

  # Channel list — empty = legacy auto-pick above
  channels: []

  # Per-channel behavior
  channelFallback: sequential       # sequential | parallel-race
  channelTimeoutMs: 30000
  channelCooldownMs: 60000         # skip failing channel for 60s
  channelFailureMode: placeholder   # placeholder | error
  autoLocalOllama: true            # probe http://localhost:11434/v1 at startup
  keysFromEnv:                     # env-var names tried when channel has no apiKey
    - VISION_API_KEY
    - DASHSCOPE_API_KEY
    - OPENAI_API_KEY
    - ZHIPUAI_API_KEY

  # Sanitization + limits
  sanitizeImages: true             # legacy field, gated by mode=tools
  cacheEnabled: true               # LRU description cache
  cacheMaxEntries: 256
  maxImageBytes: 20971520
  timeoutMs: 120000
```

### Channel examples

`channels` is an ordered list. The first successful response wins; subsequent channels are tried only on failure or 4xx.

```yaml
dsh-vision-bridge:
  channels:
    # 1. Free local Ollama (no key, image never leaves the machine)
    - type: ollama
      baseURL: http://localhost:11434/v1
      model: <OLLAMA_VL_MODEL>   # e.g. llava:13b — pick one installed locally

    # 2. OpenAI-compatible endpoint (any OpenAI-format baseURL)
    - type: openai-compatible
      baseURL: https://<PROVIDER_HOST>/v1     # OpenRouter / vLLM / Ollama-cloud / etc.
      apiKey: ""                              # empty = resolved from keysFromEnv
      model: <PROVIDER_VL_MODEL_ID>
      protocol: openai-chat                   # openai-chat | openai-responses

    # 3. Custom template (placeholder substitution; see below)
    - type: custom
      baseURL: https://<CUSTOM_HOST>/vision
      apiKey: ""
      model: <CUSTOM_MODEL>
      requestTemplate: |
        {"model":{{model}},"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":{{dataUrl}}}},{"type":"text","text":{{prompt}}}]}],"max_tokens":1024}
      responsePath: choices.0.message.content
```

Custom-template placeholders are substituted unquoted — the plugin wraps them with `JSON.stringify`. Available: `{{model}}`, `{{prompt}}`, `{{image}}` (base64 only, no `data:` prefix), `{{dataUrl}}` (full `data:image/...;base64,...`), `{{mime}}`.

## Tools

Beyond `describe_image`, the plugin exposes a vision-tool suite. In `mode: tools` the model calls them explicitly; in `hybrid`/`llm` they stay available alongside auto-rewrite.

**Grounding / geometry** — `vision_ground(image, target) → bbox`, `vision_crop(image, region) → bbox`, `vision_detect(image, kind) → [{label,bbox}]`, `vision_compare(images, q) → deltas`, `vision_present(path) → attachmentId`.

**OCR** — `vision_ocr(image)`, `vision_long_ocr(image)` (Markdown, dedup), `vision_trace(image) → svg`, `vision_colors(image, top)`, `vision_extract_foreground(image) → bbox`.

**Pixel loop** — `vision_pixel_diff(A, B) → diff`, `vision_html_screenshot(html, width, fullPage) → PNG` (headless Chrome, published), `vision_materialize(attachmentId, filename) → path`.

**Video / browser** — `vision_video_describe(path, question, frames) → summary` (ffmpeg frames), `vision_page_persist(url)`, `vision_browser_snapshot/click/navigate` (stubs).

`html_screenshot` requires Chrome at `/usr/bin/google-chrome` (or `CHROME_PATH`); `video_describe` requires `ffmpeg`. Both degrade to a clear note when the binary is absent.

**Skill** — the bundled `vision-skills` Skill (5 playbooks: long-screenshot OCR, restore UI/graphic/structure, GUI ops) is registered via `ctx.skills`, so the model loads the matching playbook when a visual task starts.

## Replacing `dsh-vision-router`

This does the same job but under your control and with your own vision model. If `dsh-vision-router` is installed, remove it:

```sh
dsh plugin --profile web remove dsh-vision-router
```

## Structure

```
dsh-vision-bridge/
├── package.json            # dsh bundle/plugin metadata + peerDependencies
├── cordis.patch.yml        # bundle layer: inserts the plugin row
├── lib/index.js            # host: pre-step sanitizer + describe_image + tools + channels + routes
├── lib/channels.js         # multi-channel driver (dsh-catalog / openai-compatible / ollama / custom) — stdlib
├── lib/cache.js            # LRU description cache + composite key
├── lib/evidence.js         # persistent description store (Block 4)
├── lib/client.js           # browser: Plugins-tab collapsible Vision card (mode/strategy/escalation/channels/bench/presets)
├── skills/vision-skills/   # bundled Skill (5 playbooks): long-screenshot OCR, restore UI/graphic/structure, GUI ops
├── README.md
└── LICENSE                 # MIT
```

## Compatibility notes

- **Default behavior is identical to v0.1.4.** Existing users upgrading see no change unless they switch mode, add channels, or change strategy/escalation.
- Settings moved from the sidebar to a **collapsible card in Plugins → Settings** (like Model Sync / Spendmeter). Fallback to the old sidebar section if the `settings.plugin.item` slot is absent.
- The plugin registers a `composer.action` slot (best-effort), a bundled `vision-skills` Skill provider, and HTTP routes `/dsh-vision-bridge/config`, `/channels`, `/models`, `/test`, `/stats`, `/bench`.
- **No new peer dependencies** (Node 22 native fetch/AbortController; Chrome/ffmpeg used only when present for `html_screenshot`/`video_describe`).

## License

MIT
