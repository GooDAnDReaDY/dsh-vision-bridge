# dsh-vision-bridge — Architecture Baseline

## Purpose

Универсальный vision-bridge для DeepSeek Harness. Текст-only модели получают
image→text rewrite (turns не падают), а явные vision-tools (25 штук) дают
модели инспекцию изображений. Пользователь выбирает способ обработки.

## Две половины

- `lib/index.js` — host (cordis): Config, apply, tools (25), channels, routes, skill.
- `lib/client.js` — browser: коллапсируемая карточка в Plugins-tab.

## Поток данных

```
image (user/tool) → agent/pre-step + llm/stream (sanitizeAllowed gate)
  → текст-only модель: rewrite image→text через vision LLM (task-aware prompt)
  → tools для явной инспекции
  → cache LRU → evidence.json (опционально persist)
```

## Режимы

- hybrid — auto-rewrite + tools
- llm — auto-rewrite only
- tools — без auto-rewrite

## Task-aware промпты (#65)

`focusHint` + `taskMode` (glance/ocr/region/compare) формируют промпт для
vision LLM на основе последней реплики пользователя.

## Каналы (6 типов)

dsh-catalog / openai-compatible / ollama / lmstudio (preset) / webhook /
custom (template). Sequential или parallel-race fallback + cooldown +
placeholder mode + auto-Ollama probe + keysFromEnv.

## Tools (25)

Core: describe_image, read_image (bridge)
Grounding: ground/crop/detect/compare/present
OCR: ocr/ocr_local/long_ocr/trace/colors/extract_foreground
Structured: describe_structured/vqa/ui_layout/translate_image
Pixel loop: pixel_diff/html_screenshot/materialize/pdf_pages
Video/browser: video_describe/page_persist/browser_snapshot/batch

## Routes

config, channels, models, test, stats, bench, costs, cache (GET+DELETE).

## Skill

vision-skills (5 playbooks) через ctx.skills.registerProvider.
