# 📦 @goodandready/dsh-vision-bridge

<div align="center">

<h3>DeepSeek Harness 通用视觉桥接、多模态转接器与 27 合 1 计算机视觉工具箱</h3>

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

## ⚡ 插件概览

**`dsh-vision-bridge`** 是为 **DeepSeek Harness** 量身定制的全能多模态视觉处理中枢。

它彻底解决了三大核心场景痛点：
1. **通用多模态视觉桥接**：当用户向**纯文本大模型**发送图片、截图或 PDF 时，插件在请求发出前自动拦截附件，调度独立配置的多通道路由提取高保真结构化图文描述并无缝融合至 Prompt 中，彻底杜绝 `model does not support image input` 报错。
2. **独立视觉大模型解耦指定**：支持为视觉任务指定**专属的独立 Vision 视觉大模型**，使主对话模型无需承担多模态解析开销，专注纯文本极速推理。
3. **27 项专属视觉工具矩阵**：为智能体赋予全套视觉感知工具（OCR、VQA、空间坐标定位、UI 原型分析、PDF 多页解析、图片对比及批量处理）。

```mermaid
graph LR
    subgraph UserTurn [用户会话输入]
        Attach[🖼️ 图像 / 屏幕截图 / PDF 文件] --> Check{当前对话模型是否原生支持视觉?}
    end

    subgraph DedicatedVision [专属视觉模型处理层]
        Check -->|原生支持 VLM| Pass[直接穿透提交模型]
        Check -->|不支持: 纯文本模型| Interceptor[视觉桥接拦截器]
        Interceptor --> Pick{独立 Vision 模型调度}
        Pick -->|自动探测| AutoVLM[目录中首个视觉大模型]
        Pick -->|显式指定| UserVLM[配置的专属视觉大模型]
        Pick -->|通道路由| Channels[多通道分发: Ollama / Webhook]
        AutoVLM --> Structured[结构化视觉特征]
        UserVLM --> Structured
        Channels --> Structured
        Structured --> Fuse[Prompt 上下文智能融合]
    end

    subgraph ChatLLM [主对话大模型]
        Pass --> LLM[纯文本极速推理输出]
        Fuse --> LLM
    end

    style UserTurn fill:#1e1e2e,stroke:#89b4fa,stroke-width:2px,color:#cdd6f4
    style DedicatedVision fill:#181825,stroke:#cba6f7,stroke-width:2px,color:#cdd6f4
    style ChatLLM fill:#11111b,stroke:#a6e3a1,stroke-width:2px,color:#cdd6f4
```

---

## 🎯 独立 Vision 模型指定与网桥运行模式

您可以将**对话推理模型**与**视觉理解模型**完全解耦：

### 1. 专属视觉模型指定 (`visionProvider` 与 `visionModel`)
* **自动探测 (默认)**：留空 (`""`) 时，系统自动在已加载的服务商目录中选用首个 `acceptsImages` 为 true 的模型。
* **显式指定专属模型**：在 **设置 → Vision Bridge** 中明确指定 `visionProvider` 与 `visionModel`。所有后台图像描述及视觉工具调用将统一路由至此模型，完全不改变聊天主模型的配置。

### 2. 网桥工作模式 (`mode`)
* `hybrid` (默认)：自动为纯文本模型补齐图片描述 **且** 同时向智能体开放全部 27 项视觉工具。
* `llm`：仅开启后台自动图片转文本注入（不向智能体暴露工具）。
* `tools`：不执行后台自动转写；智能体在感知到图片引用后，根据需要显式调用视觉工具 (`describe_image`, `vision_ocr` 等)。

---

## 📦 安装指南

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

---

## 📄 开源协议

MIT © [GooDAnDReaDY](https://github.com/GooDAnDReaDY)
