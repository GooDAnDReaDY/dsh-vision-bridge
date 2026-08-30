# 📦 @goodandready/dsh-vision-bridge

<div align="center">

[![npm version](https://img.shields.io/npm/v/@goodandready/dsh-vision-bridge.svg?style=flat-square)](https://www.npmjs.com/package/@goodandready/dsh-vision-bridge)
[![license](https://img.shields.io/github/license/GooDAnDReaDY/dsh-vision-bridge.svg?style=flat-square)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-6366f1.svg?style=flat-square)](https://github.com/topics/dsh-plugin)

**[ 🇬🇧 English ](#-english) • [ 🇷🇺 Русский ](#-русский) • [ 🇨🇳 中文 ](#-中文)**

</div>

---

<a name="-english"></a>
## 🇬🇧 English

# dsh-vision-bridge

**Universal vision bridge** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a self-contained replacement for `dsh-vision-router`.

When the chat model has **no vision** (e.g. `deepseek-v4-flash`) and a message contains an image, the image never reaches the text-only model. Instead, the plugin picks **how** to handle it — depending on the configured **mode**:

- **`hybrid`** (default) — auto-rewrite image blocks into text descriptions using a vision model; tools stay available for explicit follow-ups.
- **`llm`** — auto-rewrite via vision model only (the text-only model never sees raw images); tools remain callable.
- **`tools`** — auto-rewrite is **off**. The text model must call `describe_image` (or another tool) explicitly, otherwise the adapter fails on the raw image.

Plus, **multi-channel endpoints**: chain `dsh-catalog`, `openai-compatible`, `ollama`, `custom`, and `webhook` endpoints — sequential or parallel-race fallback, per-channel cooldown, optional placeholder on total failure, zero-config Ollama discovery, and LM Studio preset.

## Install

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

Restart the Web UI, open **Plugins → Settings → vision-bridge** (collapsible card).

## Tools (25)

### Core
| Tool | What it does |
|---|---|
| `describe_image` | Ask the vision model about an image (attachment id or local path) |
| `read_image` | Native-shape alias — read local files through the bridge when the current model can't accept images |

### Grounding / geometry
| Tool | Result |
|---|---|
| `vision_ground(image, target)` | bbox `[x1,y1,x2,y2]` in 0–1000 coords |
| `vision_crop(image, region)` | crop bbox (phrase or coords) |
| `vision_detect(image, kind)` | numbered inventory `[{label,bbox}]` |
| `vision_compare(images[], q)` | joint multi-image deltas (all images sent simultaneously) |
| `vision_present(path)` | publish local file as chat attachment |

### OCR & analysis
| Tool | Result |
|---|---|
| `vision_ocr(image)` | transcribe all visible text |
| `vision_ocr_local(image, psm)` | **local Tesseract OCR** (no network); PSM 3/4/6/11 |
| `vision_long_ocr(image)` | long screenshot OCR, stitched Markdown |
| `vision_trace(image)` | SVG vectorization |
| `vision_colors(image, top)` | dominant colors palette |
| `vision_extract_foreground(image)` | foreground bbox (SAM3 upgrade path) |

### Structured / Q&A
| Tool | Result |
|---|---|
| `vision_describe_structured(image)` | JSON: `{summary, ocr, layout[], entities[], uncertainty[]}` |
| `vision_vqa(image, question)` | short answer to a visual question (token-efficient, maxTokens=100) |
| `vision_ui_layout(image)` | structured UI breakdown: header/main/sidebar/footer with sizes and contents |
| `vision_translate_image(image)` | extract text verbatim (ready for translation by main model) |

### Pixel loop & rendering
| Tool | Result |
|---|---|
| `vision_pixel_diff(A, B)` | diff ratio + worst regions |
| `vision_html_screenshot(html, w, h)` | render HTML → PNG (headless Chrome) |
| `vision_materialize(id, filename)` | copy attachment to workspace path |
| `vision_pdf_pages(path, pages[])` | PDF pages → PNG → vision per page (requires poppler-utils) |

### Video / browser
| Tool | Result |
|---|---|
| `vision_video_describe(path, question, frames)` | ffmpeg frame extraction → vision per frame → summary |
| `vision_page_persist(url, width)` | URL screenshot → attachment (headless Chrome) |
| `vision_browser_snapshot(url)` | fetch URL → rendered text content |
| `vision_batch(images[], prompt)` | process N images in parallel |

### Binary requirements
`html_screenshot` and `page_persist` need Chrome (`/usr/bin/google-chrome` or `CHROME_PATH`). `video_describe` needs `ffmpeg`. `pdf_pages` needs `pdftoppm`. `ocr_local` needs `tesseract`. Each degrades to a clear note when absent.

## Settings

**Plugins → Settings → vision-bridge** (collapsible card):

- **Mode** — hybrid / llm / tools
- **Describe strategy** — auto / llm / ocr-local / cache-only
- **Focus hint** — pass latest user message as context to vision model
- **Task mode** — glance / ocr / region / compare
- **Escalation** — simple-only / auto-escalate
- **Vision provider / model** — explicit override; empty = auto-pick
- **Channels editor** — add/remove/reorder endpoints with status-dot per key
- **Presets** — Local / Cloud / LM Studio (one click)
- **Bench** — probe every channel, show latency
- **Test vision** — single end-to-end call

In `settings.yaml`:

```yaml
dsh-vision-bridge:
  mode: hybrid
  describeStrategy: auto
  focusHint: true                    # task-aware prompts
  taskMode: glance                   # glance | ocr | region | compare
  escalation: simple-only            # simple-only | auto-escalate
  nativePassthrough: prefer          # prefer | always | never
  visionProvider: ""
  visionModel: ""
  channels: []
  channelFallback: sequential        # sequential | parallel-race
  channelTimeoutMs: 30000
  channelCooldownMs: 60000
  channelFailureMode: placeholder    # placeholder | error
  autoLocalOllama: true
  keysFromEnv: [VISION_API_KEY, DASHSCOPE_API_KEY, OPENAI_API_KEY, ZHIPUAI_API_KEY]
  sanitizeImages: true
  cacheEnabled: true
  cacheMaxEntries: 256
  evidencePersist: false             # persist descriptions across restarts
  evidenceDir: ""                    # default = cwd
  evidenceMaxEntries: 2000
  allowedImageDirs: []               # empty = any path allowed
  auditLog: off                      # off | errors | all
  maskSecrets: true
  maxImageBytes: 20971520
  timeoutMs: 120000
```

### Channel types

```yaml
channels:
  - type: dsh-catalog         # DSH catalog model
    provider: <provider>
    model: <model>
  - type: openai-compatible   # any OpenAI-format endpoint
    baseURL: https://<HOST>/v1
    apiKey: ""
    model: <MODEL_ID>
    protocol: openai-chat     # openai-chat | openai-responses
  - type: ollama              # local Ollama
    baseURL: http://localhost:11434/v1
    model: <OLLAMA_MODEL>
  - type: lmstudio            # LM Studio (localhost:1234)
    baseURL: http://localhost:1234/v1
    model: <LMSTUDIO_MODEL>
  - type: webhook             # your own HTTP endpoint
    baseURL: https://<YOUR_SERVICE>/vision
    apiKey: ""
  - type: custom              # template-based
    baseURL: https://<CUSTOM_HOST>/vision
    requestTemplate: |
      {"model":{{model}},"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":{{dataUrl}}}}, {"type":"text","text":{{prompt}}}]}]}
    responsePath: choices.0.message.content
```

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/dsh-vision-bridge/config` | GET/POST | read/write plugin config |
| `/dsh-vision-bridge/channels` | GET/POST | list/edit channels |
| `/dsh-vision-bridge/models` | GET | list all models + vision flag |
| `/dsh-vision-bridge/test` | POST | single end-to-end call |
| `/dsh-vision-bridge/stats` | GET | per-channel usage stats |
| `/dsh-vision-bridge/bench` | POST | probe every channel latency |
| `/dsh-vision-bridge/costs` | GET | token estimate per channel |
| `/dsh-vision-bridge/cache` | GET/DELETE | cache inspector / clear |

## Skill

The bundled `vision-skills` Skill (5 playbooks: long-screenshot OCR, restore UI/graphic/structure, GUI ops) is registered via `ctx.skills.registerProvider` — the model loads the matching playbook when a visual task starts.

## Structure

```
dsh-vision-bridge/
├── package.json
├── cordis.patch.yml
├── lib/index.js            # host: sanitizer + tools + channels + routes + skill
├── lib/channels.js         # multi-channel driver (6 types) — stdlib
├── lib/cache.js            # LRU cache + composite key
├── lib/evidence.js         # persistent description store
├── lib/client.js           # browser: Plugins-tab collapsible card
├── skills/vision-skills/   # bundled Skill (5 playbooks)
├── test/regression.test.js # 32 regression tests
├── test/eval.test.js       # 6 eval tests
├── README.md
└── LICENSE                 # MIT
```

## Compatibility notes

- **Default behavior is identical to v0.1.x.**
- Settings live in a **collapsible card on Plugins tab**, fallback to sidebar if slot absent.
- No new peer dependencies. Chrome/ffmpeg/pdftoppm/tesseract used only when present; each degrades gracefully.

## License

MIT

---

<a name="-русский"></a>
<details open>
<summary><h2>🇷🇺 Русский (Полное руководство)</h2></summary>

**Универсальный мост зрения (Vision Bridge)** для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Когда модель чата **не поддерживает зрение** (например, `deepseek-v4-flash`), а сообщение пользователя содержит изображение, картинка перехватывается до отправки в модель: плагин обращается к настроенной Vision-модели (GPT-4o, Claude 3.5 Sonnet, Qwen-VL), извлекает детальное структурированное описание и передаёт его в чат вместо бинарных данных изображения. Сессия никогда не падает с ошибкой `does not support image input`.

## Возможности

- **Локальный OCR и VQA**: оптическое распознавание текста и ответы на визуальные вопросы.
- **Сравнение нескольких изображений**: анализ нескольких вложений в одном запросе.
- **Поддержка PDF**: постраничный рендеринг и анализ документов.
- **Инспектор кэша и затрат**: подсчёт токенов и кэширование повторных описаний.

## Установка

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

## Лицензия

MIT

</details>

---

<a name="-中文"></a>
<details>
<summary><h2>🇨🇳 中文 (完整技术文档)</h2></summary>

DeepSeek Harness (dsh) 专属的**通用视觉桥接插件 (Universal Vision Bridge)**。

当聊天模型**不具备视觉能力**（如 `deepseek-v4-flash`）且用户发送了图片时，插件会在请求前拦截图片，调用独立的视觉大模型（如 GPT-4o、Claude 3.5 Sonnet、Qwen-VL 等）提取结构化视觉描述并无缝融合至上下文中，彻底避免模型报出 `does not support image input` 错误。

## 核心亮点

- **本地 OCR 与 VQA**：文本提取与高精度视觉问答。
- **多图对比分析**：支持单次对话中对比多张图片差异。
- **PDF 文档解析**：自动逐页渲染与图文结构提取。
- **成本与缓存监控**：视觉分析结果持久化缓存与 Token 消耗统计。

## 安装指南

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

## 开源协议

MIT

</details>
