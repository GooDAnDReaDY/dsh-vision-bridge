# 📦 @goodandready/dsh-vision-bridge

<div align="center">

<h3>Universal Vision Bridge, Multimodal Adapter & 27-Tool Computer Vision Suite for DeepSeek Harness</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@goodandready/dsh-vision-bridge"><img src="https://img.shields.io/npm/v/@goodandready/dsh-vision-bridge.svg?style=for-the-badge&color=6366f1&labelColor=1e1b4b" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/GooDAnDReaDY/dsh-vision-bridge.svg?style=for-the-badge&color=10b981&labelColor=064e3b" alt="license"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/DSH-Plugin-8b5cf6.svg?style=for-the-badge&labelColor=2e1065" alt="DSH Plugin"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-20%2B-f59e0b.svg?style=for-the-badge&labelColor=451a03" alt="Node version"></a>
</p>

<p align="center">
  <a href="README.md"><b>🇬🇧 English</b></a> •
  <a href="README.ru.md"><b>🇷🇺 Русский</b></a> •
  <a href="README.zh.md"><b>🇨🇳 中文说明</b></a>
</p>

</div>

---

## ⚡ Overview

**`dsh-vision-bridge`** is a comprehensive multimodal processing engine for **DeepSeek Harness**. 

It solves two critical challenges:
1. **Universal Multimodal Bridging**: When users send images, diagrams, or PDFs to **text-only LLMs** (e.g. `deepseek-v4-flash`, `deepseek-chat`), the plugin automatically intercepts the attachments, extracts rich structured visual descriptions via configured vision channels, and injects the evidence seamlessly into the prompt — completely preventing `model does not support image input` crashes.
2. **27 Agent Vision Tools**: Equips agents with a full suite of computer vision tools (OCR, VQA, spatial grounding, UI wireframe parsing, PDF page extraction, image diffing, and batch processing).

```mermaid
graph LR
    subgraph Input [User Message Attachments]
        Attach[🖼️ Images / Screenshots / PDFs] --> Check{Active Chat Model Has Native Vision?}
    end

    subgraph Transparent [Transparent Vision Bridge]
        Check -->|Yes: Native VLM| Pass[Direct Model Pass-Through]
        Check -->|No: Text-Only LLM| Interceptor[Vision Bridge Interceptor]
        Interceptor --> VisionRouter{Multi-Channel Vision Router}
        VisionRouter -->|Type 1: dsh-catalog| C1[DSH Catalog: Any Active Vision Model]
        VisionRouter -->|Type 2: openai-compatible| C2[OpenAI-Compatible / vLLM / SGLang]
        VisionRouter -->|Type 3: ollama| C3[Local Ollama / Auto-Probed]
        VisionRouter -->|Type 4: custom / webhook| C4[Custom Gateway / Webhook]
        C1 --> Structured[Structured Visual Evidence]
        C2 --> Structured
        C3 --> Structured
        C4 --> Structured
        Structured --> Fuse[Prompt Injection & Context Fusion]
    end

    subgraph Execution [Chat Execution]
        Pass --> LLM[Chat Model Inference]
        Fuse --> LLM
    end

    style Input fill:#1e1e2e,stroke:#89b4fa,stroke-width:2px,color:#cdd6f4
    style Transparent fill:#181825,stroke:#cba6f7,stroke-width:2px,color:#cdd6f4
    style Execution fill:#11111b,stroke:#a6e3a1,stroke-width:2px,color:#cdd6f4
```

---

## 🌐 Dynamic Vision Channel Architecture

Rather than hardcoding static models, `dsh-vision-bridge` dynamically discovers vision models from your catalog (`acceptsImages(model)`) and routes image queries across **5 flexible channel types**:

| Channel Type (`type`) | Description | Example Configuration |
|---|---|---|
| `dsh-catalog` | Any vision-capable model already configured in your DSH providers | `{ type: 'dsh-catalog', provider: 'my-provider', model: 'my-vlm' }` |
| `openai-compatible` | Direct OpenAI-format vision endpoint (vLLM, SGLang, LiteLLM, OpenRouter) | `{ type: 'openai-compatible', baseURL: 'http://localhost:8000/v1', model: '...' }` |
| `ollama` | Local Ollama instance with automatic model discovery (`autoLocalOllama`) | `{ type: 'ollama', baseURL: 'http://localhost:11434/v1', model: '...' }` |
| `custom` | Custom HTTP payload via user-defined `requestTemplate` and `responsePath` | `{ type: 'custom', baseURL: '...', requestTemplate: {...} }` |
| `webhook` | Direct HTTP POST webhook | `{ type: 'webhook', baseURL: 'https://...' }` |

> [!TIP]
> **Zero-Config Local Vision**: If no channels are configured and Ollama is running locally (`localhost:11434`), `dsh-vision-bridge` automatically probes and binds to your local vision model on boot!

---

## 🛠️ Complete 27 Agent Vision Tools Matrix

`dsh-vision-bridge` registers 27 specialized tools in `ctx.tools`:

| Tool Name | Purpose | Key Parameters |
|---|---|---|
| `describe_image` | Full semantic captioning and general description | `image_path`, `detail_level` |
| `read_image` | Direct text reading and reading order extraction | `image_path`, `language` |
| `vision_ocr` | High-accuracy optical character recognition | `image_path`, `detect_orientation` |
| `vision_ocr_local` | 100% offline local OCR engine | `image_path` |
| `vision_long_ocr` | Multi-column, complex document OCR | `image_path`, `preserve_layout` |
| `vision_pdf_pages` | PDF multi-page extraction, rendering & OCR | `pdf_path`, `pages`, `dpi` |
| `vision_describe_structured` | Structured JSON evidence (objects, text, colors, hierarchy) | `image_path`, `schema` |
| `vision_vqa` | Visual Question Answering on specific regions | `image_path`, `question`, `bbox` |
| `vision_ground` | Spatial coordinate & bounding box grounding | `image_path`, `query` |
| `vision_crop` | Dynamic image cropping around points or bounding boxes | `image_path`, `bbox`, `target_path` |
| `vision_detect` | Object detection, counting, and classification | `image_path`, `categories` |
| `vision_compare` | Multi-image side-by-side semantic comparison | `image_paths`, `aspects` |
| `vision_pixel_diff` | Visual regression pixel-level comparison | `image_a`, `image_b`, `threshold` |
| `vision_ui_layout` | UI wireframe parsing, element hierarchy & buttons | `image_path`, `framework` |
| `vision_translate_image` | In-image text translation with replacement | `image_path`, `target_lang` |
| `vision_colors` | Color palette extraction & dominant contrast analysis | `image_path`, `palette_size` |
| `vision_extract_foreground` | Subject isolation and background removal | `image_path`, `output_path` |
| `vision_trace` | Vector diagram, blueprint, and line tracking | `image_path`, `smoothness` |
| `vision_html_screenshot` | Render HTML/CSS directly to screenshot | `html_content`, `viewport` |
| `vision_video_describe` | Video keyframe extraction & timeline summary | `video_path`, `fps` |
| `vision_batch` | Parallel batch analysis across multiple images | `image_paths`, `task` |
| `vision_browser_snapshot` | Headless browser page snapshot | `url`, `wait_selector` |
| `vision_browser_click` | Visual coordinate-based browser click | `coordinate`, `element_text` |
| `vision_browser_navigate` | Visual web page navigation | `url` |
| `vision_present` | Visual presentation & highlight formatting | `image_path`, `highlights` |
| `vision_materialize` | Visual asset materialization & caching | `asset_ref` |
| `vision_page_persist` | Multi-turn visual context persistence | `session_id`, `state` |

---

## 📊 Performance, Caching & Cost Monitoring

* **Disk LRU Evidence Cache**: Repeated images or identical screenshots are hashed and served from cache with **0 latency and $0 token cost**.
* **Real-time Cost & Token Tracker**: Exposes usage statistics via `GET /dsh-vision-bridge/costs` and `GET /dsh-vision-bridge/stats`.
* **Built-in Benchmark Suite**: Run latency diagnostics across all configured vision channels via `GET /dsh-vision-bridge/bench`.

---

## 📦 Quick Installation

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

> [!IMPORTANT]
> Restart DSH Web UI after installation (`systemctl --user restart dsh-web`) and reload the browser tab.

---

## ⚙️ Configuration Example (`settings.yaml`)

```yaml
dsh-vision-bridge:
  enabled: true
  autoLocalOllama: true
  channels:
    - type: dsh-catalog
      provider: my-provider
      model: my-vision-model
    - type: openai-compatible
      baseURL: http://127.0.0.1:8000/v1
      model: vllm-vision
      keyEnv: LOCAL_KEY
    - type: ollama
      baseURL: http://127.0.0.1:11434/v1
  channelFallback: sequential
  channelTimeoutMs: 30000
  cacheEnabled: true
  maxCacheMb: 250
  pdfDpi: 200
```

---

## 🔌 HTTP API Routes

| Route | Method | Description |
|---|---|---|
| `/dsh-vision-bridge/models` | `GET` | Discovers available vision models in DSH catalog (`acceptsImages`) |
| `/dsh-vision-bridge/channels` | `GET, POST` | Inspects or updates active vision routing channels |
| `/dsh-vision-bridge/costs` | `GET` | Returns aggregated token consumption and estimated cost per channel |
| `/dsh-vision-bridge/cache` | `GET, DELETE` | Inspects or clears the disk visual evidence cache |
| `/dsh-vision-bridge/stats` | `GET` | Channel invocation statistics, average latency, and error counters |
| `/dsh-vision-bridge/bench` | `GET` | Latency and throughput benchmark across configured channels |

---

## 📄 License

MIT © [GooDAnDReaDY](https://github.com/GooDAnDReaDY)
