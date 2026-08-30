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

Vision bridge for DeepSeek Harness: images uploaded to text-only chat models are automatically routed to a vision backend (e.g. GPT-4o, Claude 3.5 Sonnet, Qwen-VL) to extract rich descriptions, so turns never fail.

### Features

- **Seamless Multimodal Routing**: Automatically detects images in messages sent to text-only LLMs.
- **Configurable Vision Backend**: Designate a dedicated vision model for analyzing screenshots, charts, diagrams, and photos.
- **Prompt Preservation**: Combines the original user query with the structured visual description seamlessly.
- **Error Prevention**: Eliminates model rejection errors on image uploads.

### Install

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

---

<a name="-русский"></a>
<details open>
<summary><h2>🇷🇺 Русский (Полное руководство)</h2></summary>

Мультимодальный мост зрения для DeepSeek Harness: изображения, отправленные в текстовые модели, автоматически перенаправляются на Vision-модель (GPT-4o, Claude 3.5 Sonnet, Qwen-VL) для получения описания, исключая сбои диалога.

### Возможности

- **Прозрачная маршрутизация**: перехватывает картинки в сообщениях, адресованных текстовым LLM.
- **Выбор Vision-движка**: отдельная настройка модели для анализа скриншотов, диаграмм и фотографий.
- **Сохранение контекста**: объединяет исходный вопрос пользователя с детальным визуальным описанием.
- **Защита от ошибок**: полностью исключает падения сессий из-за неподдерживаемых медиа-вложений.

### Установка

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

</details>

---

<a name="-中文"></a>
<details>
<summary><h2>🇨🇳 中文 (完整技术文档)</h2></summary>

DeepSeek Harness 视觉桥接适配插件：自动将发送给纯文本模型的图片路由至视觉模型（如 GPT-4o、Claude 3.5 Sonnet、Qwen-VL）进行深度解析并提取描述，彻底解决模型报错问题。

### 核心亮点

- **无缝多模态转接**：自动识别发送给非视觉模型的图片附件。
- **独立视觉引擎配置**：可指定专门的视觉分析模型处理截图、图表与照片。
- **上下文自然融合**：将视觉分析结论与用户原始 Prompt 智能拼装。
- **杜绝接口异常**：彻底消除因模型不支持图片输入导致的交互中断。

### 安装方法

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

</details>
