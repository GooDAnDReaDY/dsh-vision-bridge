# 📦 @goodandready/dsh-vision-bridge

<div align="center">

<h3>Универсальный мост зрения и мультимодальный адаптер для чисто текстовых LLM</h3>

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

## ⚡ Обзор

**`dsh-vision-bridge`** исключает сбои сессий при отправке изображений в чисто текстовые языковые модели (например, `deepseek-v4-flash`). Плагин перехватывает картинки, запрашивает структурированное описание у выделенной Vision-модели (GPT-4o, Claude 3.5 Sonnet, Qwen-VL) и бесшовно передаёт его в чат.

```mermaid
graph LR
    User[👤 Пользователь отправляет фото] --> Intercept{Модель поддерживает Vision?}
    Intercept -->|Да| Direct[Прямой запрос к модели]
    Intercept -->|Нет: Текстовая| Bridge[Адаптер Vision Bridge]
    Bridge --> VLM[Vision-модель GPT-4o / Qwen-VL]
    VLM --> Fusion[Внедрение визуального описания]
    Fusion --> TextLLM[Ответ текстовой LLM]
```

---

## 📦 Быстрая установка

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

---

## 📄 Лицензия

MIT © [GooDAnDReaDY](https://github.com/GooDAnDReaDY)
