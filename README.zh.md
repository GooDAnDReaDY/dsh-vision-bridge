# 📦 @goodandready/dsh-vision-bridge

<div align="center">

<h3>DeepSeek Harness 通用视觉桥接与纯文本大模型多模态适配插件</h3>

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

**`dsh-vision-bridge`** 解决用户向纯文本大模型（如 `deepseek-v4-flash`）发送图片导致的会话中断问题。自动调用独立视觉模型提取结构化图文描述并无缝拼接至 Prompt 中。

```mermaid
graph LR
    User[👤 用户上传图片附件] --> Intercept{当前模型是否支持视觉?}
    Intercept -->|支持| Direct[直接提交模型处理]
    Intercept -->|不支持: 纯文本| Bridge[视觉桥接适配器]
    Bridge --> VLM[专属视觉大模型 GPT-4o / Qwen-VL]
    VLM --> Fusion[结构化视觉特征融合]
    Fusion --> TextLLM[纯文本模型顺畅推理]
```

---

## 📦 安装指南

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

---

## 📄 开源协议

MIT © [GooDAnDReaDY](https://github.com/GooDAnDReaDY)
