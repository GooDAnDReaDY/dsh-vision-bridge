# dsh-vision-bridge — index

Навигационная карта плагина. Подробности — в `docs/` и `AGENTS.md`.

## Назначение

Универсальный vision-мост для DeepSeek Harness: подмена изображений текстовыми
описаниями для text-only моделей, мультиканальные vision-эндпоинты, набор
vision-инструментов.

## Статус

- Версия: источник истины — `package.json` (npm `@goodandready/dsh-vision-bridge`); релизы — по явному «ок» владельца
- Текущий релиз: **0.5.33** (attach-домен для нативных vision-моделей, выдача инструментов по модели, настройки `attachMaxItems`/`hideRedundantTools` в карточке, `DELETE /batch/:id`, исправления стабильности); проверен на тест-контуре MiniPC и на production
- Тесты: `npm test` — 241/241 (82 suites, 0 fail, ~3.5 с); CI — один прогон на коммит, poppler+ffmpeg в образе
- Milestone: эпик #241 (направления B/C/D — после 0.5.33)
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
npm test                                                  # весь набор node --test
node --check lib/*.js                                     # синтаксис
node --test --experimental-test-coverage test/*.test.js   # покрытие (порог правил: 80%)
```

## Зависимости и аудит

- **Runtime-зависимостей нет**: `dependencies` пуст, объявлены только peer-зависимости хоста DSH (`@deepseek-ai/cordis`, `dsh-tools`, `dsh-llm`, `dsh-attachment`, `dsh-agent`, `dsh-host-webserver`, `schemastery`); их предоставляет харнесс. `npx npm-check-updates` → «No dependencies».
- **`npm audit` / `pnpm audit` неприменимы намеренно**: `pnpm-lock.yaml` в `.gitignore`, lockfile в git не хранится, команды падают с `ENOLOCK` / `ERR_PNPM_AUDIT_NO_LOCKFILE` (issue #256). Это осознанный эквивалент проверки зависимостей для этого проекта, а не пропуск.
- **Эквивалент проверки**: пустой `dependencies` (нет транзитивных зависимостей), явный `files`-манифест пакета, разрешение peer-зависимостей в CI (`npm install` + `npm test`) и size guard (`npm pack --dry-run`, лимит 262144 B на файл).
- Хранить lockfile и вернуться к `pnpm audit` (вариант B по #256) можно только отдельной задачей с согласованием: это меняет процесс сборки и установки.

## Deploy

Установка опубликованной npm-версии в профиль `web` + `systemctl restart dsh-web`.
Проверка: `curl http://127.0.0.1:3080/dsh-vision-bridge/doctor` → 200.
