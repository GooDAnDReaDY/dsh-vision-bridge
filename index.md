# dsh-vision-bridge — index

Навигационная карта плагина. Подробности — в `docs/` и `AGENTS.md`.

## Назначение

Универсальный vision-мост для DeepSeek Harness: подмена изображений текстовыми
описаниями для text-only моделей, мультиканальные vision-эндпоинты, набор
vision-инструментов.

## Статус

- Версия: источник истины — `package.json` (npm `@goodandready/dsh-vision-bridge`); релизы — по явному «ок» владельца
- Milestone: серия issues #197–#215 (ревью качества 2026-09-09)
- Runtime: профиль `web` на `192.168.1.111`, `dsh-web`, порт `3080`

## Entry points

- Установка: `dsh plugin --profile web add @goodandready/dsh-vision-bridge`
- HTTP-роуты: `/dsh-vision-bridge/config /channels /models /test /stats /bench /costs /cache /doctor /journal /batch`
- Карточка настроек: Plugins → Settings → vision-bridge

## Компоненты

- `lib/index.js` — хост: apply(), инструменты, каналы, роуты, слушатели
- `lib/vision-core.js` — чистое ядро: Config и module-level хелперы (#206)
- `lib/tools/` — доменные файлы инструментов: core (describe/read/inspect), grounding, ocr, document, analysis, media (#206)
- `lib/channels.js` — мультиканальный драйвер (6 типов), ротация ключей, Retry-After
- `lib/client.js` — браузерная карточка настроек
- `lib/cache.js` — LRU-кэш + составной ключ
- `lib/evidence.js` — персистентное хранилище описаний
- `lib/journal.js` — vision journal (аудит-трейл вызовов)
- `test/` — исполняющий набор (node --test): smoke поверх apply() через mock-ctx (test/harness.js), security- и ux- suite

## Build / test

```bash
npm test          # весь набор node --test (счётчик — в выводе прогона)
node --check lib/*.js
```

## Deploy

Установка опубликованной npm-версии в профиль `web` + `systemctl restart dsh-web`.
Проверка: `curl http://127.0.0.1:3080/dsh-vision-bridge/doctor` → 200.
