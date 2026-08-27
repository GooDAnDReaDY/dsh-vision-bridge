# dsh-vision-bridge — index

Навигационная карта плагина. Подробности — в `docs/` и `AGENTS.md`.

## Назначение

Универсальный vision-мост для DeepSeek Harness: подмена изображений текстовыми
описаниями для text-only моделей, мультиканальные vision-эндпоинты, набор
vision-инструментов.

## Статус

- Версия: `0.4.3` (npm `@goodandready/dsh-vision-bridge`)
- Milestone: `0.4.3 — streaming + observability`
- Runtime: профиль `web` на `192.168.1.111`, `dsh-web`, порт `3080`

## Entry points

- Установка: `dsh plugin --profile web add @goodandready/dsh-vision-bridge`
- HTTP-роуты: `/dsh-vision-bridge/config /channels /models /test /stats /bench /costs /cache /doctor /journal /batch`
- Карточка настроек: Plugins → Settings → vision-bridge

## Компоненты

- `lib/index.js` — хост: sanitizer, инструменты, каналы, роуты, skill
- `lib/channels.js` — мультиканальный драйвер (6 типов), ротация ключей, Retry-After
- `lib/client.js` — браузерная карточка настроек
- `lib/cache.js` — LRU-кэш + составной ключ
- `lib/evidence.js` — персистентное хранилище описаний
- `lib/journal.js` — vision journal (аудит-трейл вызовов)
- `test/` — 42 теста

## Build / test

```bash
npm test          # 42 теста
node --check lib/*.js
```

## Deploy

Установка опубликованной npm-версии в профиль `web` + `systemctl restart dsh-web`.
Проверка: `curl http://127.0.0.1:3080/dsh-vision-bridge/doctor` → 200.
