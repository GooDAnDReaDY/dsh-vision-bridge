# AGENTS.md

Этот файл дополняет корневой `A:\mnt\external\Project\DEV\AGENTS.md` и
содержит только правила и факты, специфичные для данного проекта.

## Product / Purpose

- Проект: `dsh-vision-bridge`
- DEV: `/mnt/external/Project/DEV/dhsplugins/dsh-vision-bridge`
- OPT: нет отдельного OPT-каталога; развёртывается как DSH-плагин в профиле `web` на `192.168.1.111` (`dsh-web`, порт 3080)
- Назначение: универсальный vision-мост для DeepSeek Harness — подмена изображений текстовыми описаниями для text-only моделей, мультиканальные vision-эндпоинты, инструменты vision
- Основные пользователи: операторы DSH-профиля `web`
- Основной результат работы продукта: text-only модель не падает на изображениях; изображения описываются выбранной vision-моделью
- Текущий статус: `active`
- Статус проверен: `27.08.2026, dsh-web active, /doctor /stats /channels отвечают`

## Project Index (`index.md`)

- `index.md` создан и проверен: `да`
- Назначение и текущий статус: навигационная карта плагина
- DEV / OPT: DEV `/mnt/external/Project/DEV/dhsplugins/dsh-vision-bridge`; runtime — профиль `web`
- Точки запуска и пользовательские entry points: `dsh plugin --profile web add @goodandready/dsh-vision-bridge`; HTTP-роуты `/dsh-vision-bridge/*`
- Основные компоненты и ссылки на подробную документацию: `lib/index.js` (хост), `lib/channels.js` (драйвер каналов), `lib/client.js` (карточка настроек), `lib/cache.js`, `lib/evidence.js`
- Проверенные команды build / test: `npm test` (42 теста), `node --check lib/*.js`
- Штатный deploy: установка опубликованной npm-версии в профиль `web` + `systemctl restart dsh-web`
- Дата и способ последней проверки: `27.08.2026, curl /doctor /stats /channels`

## Essential Files

- `lib/index.js` — хост: sanitizer, инструменты, каналы, роуты, skill
- `lib/channels.js` — мультиканальный драйвер (6 типов), ротация ключей, Retry-After
- `lib/client.js` — браузерная карточка настроек (settings.plugin.item)
- `lib/cache.js` — LRU-кэш + составной ключ
- `lib/evidence.js` — персистентное хранилище описаний
- `cordis.patch.yml` — слой бандла (name = `@goodandready/dsh-vision-bridge`)
- `package.json` — версия, peerDependencies, dsh.bundle/client
- `test/regression.test.js`, `test/eval.test.js` — тесты (42)
- `docs/` — adr, architecture, research, testing

## Key Architecture

- Основные компоненты: хост (`lib/index.js`) + драйвер каналов (`lib/channels.js`) + браузерная карточка (`lib/client.js`)
- Архитектурный подход: серверная половина — модуль cordis; браузерная — `window.__ModuleLoader__.load`; общение только через HTTP-роуты `/dsh-vision-bridge/*`
- Основные API и интерфейсы: `POST /retrieve` нет; роуты `/config /channels /models /test /stats /bench /costs /cache /doctor`
- Источник истины для данных: конфиг плагина (`settings.yaml` → `dsh-vision-bridge:`), кэш описаний
- Источник истины для конфигурации: `Config` (schemastery) в `lib/index.js`

## Constraints (MUST NOT)

- Запрещено: force push, force tag, `npm/pnpm --force`, `dsh plugin ... --force`, `--no-verify`
- Запрещено: публикация (npm/GitHub) до чистой production-проверки и явного «ок»
- Запрещено: `file:`-ссылки на `.worktrees/` в профиле/манифесте/lockfile
- Запрещено: обезличенность — никаких `/mnt`, `/opt`, IP, имён машин, ключей в коде/README/коммитах
- Изменения, требующие явного согласования: deploy/restart `dsh-web`, правка профиля `web`, публикация релиза, изменение API/UI/scope

## Conventions

- Именование: ветки `feat/<milestone>-<slug>`, `fix/<milestone>-<slug>`; коммиты Conventional Commits
- Организация кода: серверная логика в `lib/`, тесты в `test/`, документация в `docs/`
- Проектные соглашения: карточка настроек в `settings.plugin.item` (ключ = пространство), ядровый шеврон, хуки выше возвратов, однократная точка входа
- Обычный способ реализации изменений: Gitea issue → worktree от origin/main → реализация → тесты → PR → merge → deploy → проверка → cleanup

## Locked Decisions

- `27.08.2026` — публикация только из проверенного `main/tag` worktree, без RELEASE-копий
  - Причина: единый канонический артефакт
  - Основание: `dhs-plugin-release-workflow`
  - Условие пересмотра: явное решение пользователя

## Dependencies

- Внешние API: vision-эндпоинты (openai-compatible, ollama, custom, webhook)
- Критичные runtime-зависимости: `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/schemastery` (peer)
- Внешние бинари (опционально): tesseract, ffmpeg, pdftoppm, google-chrome

## Build And Run

- Установка: `dsh plugin --profile web add @goodandready/dsh-vision-bridge`
- Сборка: нет (чистый JS, ESM)
- Запуск в DEV: `npm test` в worktree; `node --check lib/*.js`
- Необходимые сервисы: `dsh-web` (профиль `web`)
- Проверка успешного запуска: `curl http://127.0.0.1:3080/dsh-vision-bridge/doctor` → 200

## Testing

- Обязательные проверки: `node --check lib/*.js`, `npm test` (42 теста)
- Unit-тесты: `test/regression.test.js`, `test/eval.test.js`
- Integration-тесты: smoke через HTTP-роуты на production
- Lint/typecheck: нет отдельного линтера; `node --check`
- Критерии готовности: 42/42 тестов, `node --check` чистый, smoke-роуты отвечают

### Definition of Done

- Реализация завершена и закоммичена
- План проверок выполнен, результаты приложены
- Независимый review: PASS / FAIL
- Документация/комментарии в коде обновлены
- Готовность deploy подтверждена

## Gitea Project Setup

- Репозиторий Gitea: `goodandready/dsh-vision-bridge`
- Основная ветка: `main`
- Issue labels: `hotfix`, `priority/H|M|L`, `status/confirmed`, `type/docs|feature|refactor|test`
- Milestones: `0.4.3 — streaming + observability` (id 29)
- Releases / protected tags: `v<version>`

## Commits, Versions And Releases

- Формат коммита: `<type>(<scope>): <краткое описание>`
- Допустимые commit types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`
- Как связываются коммиты с Gitea issues: footer `Refs: #<номер>`
- Один завершённый логический результат = один commit: `да`
- Текущая версия продукта: `0.4.3`
- Planned / active milestone: `0.4.3 — streaming + observability`
- Правило повышения `x.y.z`: обычный релиз меняет только `z`; переход `y` — только по явному согласованию пользователя

## Deployment

- DEV: `/mnt/external/Project/DEV/dhsplugins/dsh-vision-bridge`
- OPT: нет; runtime — профиль `web` на `192.168.1.111`
- Порт: `3080`
- Штатный способ деплоя: установка опубликованной npm-версии в профиль `web` + `systemctl restart dsh-web`
- Необходимые действия перед деплоем: обновить `minimumReleaseAgeExclude` в `pnpm-workspace.yaml` профиля
- Проверки после деплоя: `systemctl is-active dsh-web`, `curl /doctor /stats /channels`, client.js 200

## Known Issues And Limitations

- Подтверждённые ограничения: без sharp нет реального downscale (только reject >4MP); `vision_long_ocr` без sharp — single-pass
- Связанные issues: #90 (inline preview — display-layer, отложен)
- Известный технический долг: карточка использует свои треугольники `▴/▾` вместо ядрового шеврона (issue #111)

## Open Questions

- Нет открытых вопросов

## Maintenance

- После ручных изменений перечитать этот файл и проверить на противоречия с корневым `AGENTS.md`
- Если ошибка агента могла быть предотвращена отсутствующим правилом, предложить обновление этого файла
