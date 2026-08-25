# dsh-vision-bridge — Architecture Baseline

## Purpose

Универсальный vision-bridge для DeepSeek Harness: текст-только модели получают
image→text rewrite (turns не падают), а явные vision-tools дают модели инспекцию
изображений. Пользователь выбирает способ: отдельная vision-модель (auto-rewrite),
готовые tools, или hybrid.

## Две половины

- `lib/index.js` — host (cordis): `Config`, `apply`, tools, channel driver, routes.
- `lib/client.js` — browser: `window.__ModuleLoader__.load`, коллапсируемая карточка в Plugins.

## Поток

```
image (user/tool) → agent/pre-step + llm/stream (sanitizeAllowed gate)
  → текст-только модель: rewrite image→text через vision-модель
  → tools доступны для явной инспекции (ground/crop/ocr/pixel_diff/…)
  → cache LRU (bytes+prompt+model+mode) → evidence.json (опц. persist)
```

## Режимы

- `hybrid` (default) — auto-rewrite + tools
- `llm` — auto-rewrite only
- `tools` — без auto-rewrite, модель сама зовёт tools

## Каналы

`channels[]` — ordered list; `channelFallback: sequential | parallel-race`;
per-channel timeout/cooldown; `failureMode: placeholder | error`;
`autoLocalOllama` probe; `keysFromEnv`. Types: dsh-catalog / openai-compatible /
ollama / custom.

## Native passthrough

`nativePassthrough: prefer | always | never` — гейт, видит ли vision-capable
conversation-модель картинку нативно (`shouldBridgeForModel`).

## Routes

`/config`, `/channels`, `/models`, `/test`, `/stats`, `/bench`.

## Skill

`vision-skills` (5 playbooks) регистрируется через `ctx.skills.registerProvider`
(эталон: dsh-visualize).
