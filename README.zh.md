# 📦 @goodandready/dsh-vision-bridge

<div align="center">

<h3>DeepSeek Harness 通用视觉桥接插件：为纯文本模型提供无缝多模态图像支持</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@goodandready/dsh-vision-bridge"><img src="https://img.shields.io/npm/v/@goodandready/dsh-vision-bridge.svg?style=for-the-badge&color=6366f1&labelColor=1e1b4b" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/GooDAnDReaDY/dsh-vision-bridge.svg?style=for-the-badge&color=10b981&labelColor=064e3b" alt="license"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/DSH-Plugin-8b5cf6.svg?style=for-the-badge&labelColor=2e1065" alt="DSH Plugin"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-20%2B-f59e0b.svg?style=for-the-badge&labelColor=451a03" alt="Node version"></a>
</p>

<!-- Showcase Button -->
<p align="center">
  <a href="https://goodandready.app/"><img src="https://img.shields.io/badge/全部作品展厅-goodandready.app-ff4500.svg?style=for-the-badge&logo=rocket&logoColor=white&labelColor=1a1a2e" alt="GoodAndReady Showcase"></a>
</p>

<p align="center">
  <a href="README.md"><b>🇬🇧 English</b></a> •
  <a href="README.ru.md"><b>🇷🇺 Русский</b></a> •
  <a href="README.zh.md"><b>🇨🇳 中文说明</b></a>
</p>

</div>

---

## ⚡ 概述与核心解决问题

在 **DeepSeek Harness** 中与纯文本模型（如 `deepseek-v3`、Qwen 纯文本版本等）对话时，用户无法直接在聊天窗口附加和发送图片：

1. 在 **DSH 0.1.2-alpha.2+** 中，后端会话控制器进行严格的模态校验 (`ctx.llm.resolveModelInfo`)。如果当前对话模型的 `inputModalities` 中不包含 `'image'`，请求会被直接拒绝并报错 `session/attachment-invalid` ("Model does not support image input")。
2. 纯文本适配器如果直接接收到多模态图像块，会抛出请求错误。

### `dsh-vision-bridge` 解决方案

`dsh-vision-bridge` 在 Cordis 运行时内建立透明代理：
* **服务端模态桥接 (v0.5.3+)**：自动包装 `ctx.llm.resolveModelInfo` 和 `ctx.llm.listModels`，使会话网关允许所有模型接收图像附件。
* **自动图像改写 (`agent/pre-step` 与 `llm/stream`)**：自动拦截图片，调用独立的视觉模型（如 Gemini、Claude、Qwen-VL 或本地 Ollama）生成描述，并将图片替换为文本提示 `[用户上传了图片。内容描述：...]` 传递给纯文本模型。
* **原生直通 (Native Passthrough)**：自动识别原生支持视觉的模型并直接传递图像，无需重复转换。
* **26 个专用视觉工具**：提供 OCR、目标定位 (grounding)、UI 结构解析和图像比对等完整工具套件。

---

## 🏗️ 架构图

```mermaid
graph LR
    User["用户在 Web UI 上传图片"] --> Gateway["DSH 会话控制器"]
    Gateway --> BridgeCheck{"模态桥接 (v0.5.3)"}
    BridgeCheck -->|"inputModalities 扩展 image"| SessionAllowed["网关放行请求"]
    SessionAllowed --> Hook["agent/pre-step 钩子"]
    
    Hook --> CheckNative{"对话模型是否原生支持视觉？"}
    CheckNative -->|"是 (Native Passthrough)"| NativeLLM["直接传递原始图像"]
    CheckNative -->|"否 (纯文本模型)"| VisionRouter["视觉桥接通道"]
    
    VisionRouter --> VisionModel["专用视觉模型\n(DSH / OpenAI / Ollama / Webhook)"]
    VisionModel --> Description["生成文字描述与 OCR"]
    Description --> Rewrite["将图片替换为文字描述标记"]
    Rewrite --> ChatModel["将增强文本发送给对话模型"]
    ChatModel --> Answer["助手在聊天窗口返回答案"]
```

---

## ✨ 核心特性

### 1. 运行模式
* **`hybrid` (默认)**：对话中自动改写图片为文本描述，同时保留 26 个工具供模型显式调用。
* **`llm`**：纯自动改写模式；工具依然可供调用。
* **`tools`**：禁用自动改写，必须由模型显式调用 `describe_image` 等工具。

### 2. 多通道故障转移 (Multi-Channel Fallback)
支持多视觉后端级联、故障熔断与并发竞速：
* `dsh-catalog`：自动或手动选择 DSH 中已注册的视觉模型。
* `openai-compatible`：支持 vLLM、SGLang、OpenRouter 等 OpenAI 兼容视觉接口。
* `ollama`：自动发现并调用本地 Ollama 视觉模型。
* `webhook` / `custom`：外部 HTTP / JSON-RPC 服务。

### 3. LRU 响应缓存
基于 `hash(bytes + prompt + model + mode)` 的内存缓存，避免重复分析相同图片，节省 Token 开销。

---

## 📦 安装方法

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

安装完成后重启 DSH Web UI。配置卡片位于 **设置 → 插件 → vision-bridge**。

---

## ⚙️ 配置示例 (`settings.yaml`)

```yaml
dsh-vision-bridge:
  mode: hybrid
  visionProvider: ""
  visionModel: ""
  nativePassthrough: prefer
  cacheEnabled: true
  cacheMaxEntries: 200
  timeoutMs: 120000
  channels: []
  channelStrategy: fallback
```

---

## 📄 开源许可

MIT © [GooDAnDReaDY](https://github.com/GooDAnDReaDY)