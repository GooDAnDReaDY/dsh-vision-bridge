# Design Contract: dsh-vision-bridge

## 1. Назначение продукта и сценарии
Флагманский мультимодальный хаб компьютерного зрения для DeepSeek Harness.
Обеспечивает подключение локальных (Ollama, vLLM, SGLang) и облачных (OpenAI-compatible, DashScope, Claude, DeepSeek-VL, Janus-Pro) Vision-моделей к чату DSH, автоматическое описание прикреплённых изображений, распознавание формул LaTeX, сложных таблиц, QR/штрихкодов, аудит доступности интерфейсов, генерацию UI-flow диаграмм, consensus-валидацию и постраничную обработку PDF.

## 2. Пользовательские поверхности
- **Панель ввода чата (Composer)**:
  - Слот `conversation.input.right`: кнопка переключения режима (`👁️ Vision: hybrid / llm / tools`) и быстрая загрузка PDF (`📄 +PDF`).
  - Глобальный Drag-and-Drop: перетаскивание PDF-файлов в окно чата с авто-нарезкой страниц и превью.
  - Полноэкранный Lightbox для просмотра изображений в чате по клику.
- **Настройки (Settings)**:
  - Карточка плагина в слоте `settings.plugin.item` (пространство `dsh-vision-bridge`, без верхнеуровневого `settings.section`).
  - Привязка к `ctx.settingsScope` (`namespace: 'dsh-vision-bridge'`).
- **Инструменты агента (Tools)**:
  - 30+ инструментов (`describe_image`, `vision_ocr`, `vision_extract_formula`, `vision_extract_table`, `vision_scan_barcode`, `vision_ui_flow` и др.).

## 3. Визуальное направление и стили
- Нативный минималистичный UI, полностью повторяющий системные токены DSH (`--dsw-alias-*`).
- Кнопки в строке ввода (`.vbr-input-btn`): компактные бейджи высотой 28px, не перегружающие интерфейс.
- Карточка настроек: аккордеон с четким разделением каналов, ключей и стратегий.

## 4. Контракт безопасности и данных

### 4.1 Настройки (актуально с пачки 3, #203/#212)
- Работают end-to-end: `maskPII` (маскирование промпта), `stripEXIF` (pipeline), `auditLog` (гейтит journal: off/errors/all), `consensusEnabled` (включает `vision_consensus`, по умолчанию выключен), `allowedUrlHosts` (SSRF-allowlist), `apiKeyRef` (каналы без открытых ключей).
- Удалены как декоративные: blurFaces, nsfwFilter, tileLargeImages/tileThreshold, пресеты Local/Cloud/LM Studio (делали ничего).
- Исходный язык интерфейса — английский; ручной ru-дубль в плагине отсутствует (ru даёт translation-плагин). Пресеты/тосты/тултипы переведены в EN-ключи.
- Секретные ключи API никогда не возвращаются в открытом виде в браузер через GET-запросы.
- Мутирующие запросы защищены гардом `isTrustedSettingsRequest` (`sec-fetch-site !== 'cross-site'`).
- Временные файлы в `/tmp` гарантированно очищаются в блоке `finally`.

## 5. Security notes (batch 2, #200-#211)

- Серверный fetch URL-источников (`describe_image` urls, `inspect_image`,
  `resolveSourceBytes`) идёт только через `safeFetch`: политика применяется к
  каждому редирект-прыжку; тела ограничены `maxImageBytes`.
- `allowedUrlHosts` — точный hostname-allowlist; непустой список полностью
  заменяет DNS-проверку. Приватные/loopback/link-local хосты (включая
  IPv4-mapped IPv6 `::ffff:0:0/96` и NAT64 `64:ff9b::/96`) отклоняются всегда,
  кроме явно названных в allowlist.
- Известные ограничения (принятые, документированные): DNS-rebinding TOCTOU
  (валидация и transfer резолвят DNS независимо; полное закрытие требует pin
  валидированного адреса); headless-chrome инструменты
  (`vision_page_persist`, `vision_browser_snapshot`) проверяют URL до запуска,
  но DNS резолвит сам chrome.
- `apiKeyRef` в каналах — имя credential/env-переменной, значение резолвится в
  момент вызова; в settings.yaml ключ в открытом виде больше не требуется.
  GET /channels по-прежнему возвращает только маскированные значения.
- Мутирующие и платные роуты (`/bench`, `/batch`, `DELETE /journal`,
  `DELETE /cache`, `/config`, `/channels`, `/test`, `/upload-pdf`) требуют
  same-origin (`sec-fetch-site != cross-site`). `GET /doctor` по умолчанию
  статический; пробы каналов — только с `?probe=1`.

### 6. Единый стиль UI (#226, эталон dsh-clinebot)
- Карточка: секция border-l2 / bg-layer-3 / radius 12px, padding 18px 20px, gap 14px; заголовок 16px/600; описание 13px вторичным цветом; тело отделено бордером.
- Статус-бейджи (.vbr-badge-ok/warn/bad/neutral, 12px pill + полупрозрачный фон состояния): здоровье каналов в шапке карточки (ch ok/total) и статус каждой строки канала (key/circuit).
- Инпуты и селекты: 36px, bg-layer-2, focus ring state-brand-primary; кнопки 36px с focus-visible.
- ErrorBoundary (createErrorBoundary) оборачивает карточку настроек и композер-контролы: деградация рендера показывает alert с сообщением и Retry, не роняя страницу.
- registerSlotWhenReady: retry-регистрация settings.plugin.item и conversation.input.right (до 20 попыток, 500мс).
- Тосты PDF: цвета из state-токенов (успех/ошибка) вместо хардкода.
- Визуальная приёмка: следующий release-цикл на MiniPC (карточка: collapsed/expanded/loading/error-boundary; композер: переключение режимов, PDF-тосты).
- Семантика бейджей: канал «ok» = circuit не open И (есть ключ ИЛИ тип без ключа — ollama/dsh-catalog); «warn» = нет ключа у типа с ключом; «bad» = circuit open. Карточный агрегат (ch ok/total) использует ту же логику.

### 7. Model-aware выдача инструментов (#242)
- Если активный маршрут чата поддерживает изображения нативно — агенту скрываются **компенсационные** инструменты (те, что нужны только text-only модели): describe_image, read_image, inspect_image, vision_vqa, vision_cot, vision_self_check, vision_describe_structured, vision_ui_layout, vision_translate_image, vision_to_code, vision_audit_accessibility, vision_ui_flow, vision_math_extract, vision_extract_formula/table/structured, vision_scan_barcode, vision_qr_read, vision_trace, vision_colors, vision_quality_check, vision_diff, vision_pixel_diff, vision_ground, vision_detect, vision_crop, vision_annotate, vision_extract_foreground.
- Остаются как доп. функционал: vision_pdf_pages, vision_video_describe, vision_html_screenshot, vision_page_persist, vision_browser_snapshot, vision_batch, vision_materialize, vision_present, vision_export_report, vision_memory_search, vision_verify_generated_image, vision_consensus, vision_ocr_local, vision_long_ocr. vision_compare (совместный структурный анализ).
- Механизм: per-agent `agent.ctx.tools.restrict({deny})` по capability маршрута (как ядровый read_image: `agent.session.requestHeader().config` -> `llm.resolveModelInfo`, native — по `_nativeInputModalities`). Маска снимается/переприменяется при смене маршрута; при недоступности restrict — полный список и однократный warn.
- Настройка: `hideRedundantTools` (default true) выключает поведение целиком (снимает уже наложенную маску).
- Маска следует политике моста (`shouldBridgeForModel`): при `nativePassthrough: never` (принудительная подмена даже у vision-модели) компенсационные инструменты остаются доступны; при `always` (мост выключен) — скрыты.
- Refs: vision_ocr скрывается (LLM-транскрипция — компенсация), vision_ocr_local остаётся (точный движок). Известное ограничение: маршрут берётся из `session.requestHeader()` — при смене модели посреди сессии маска может отстать на один шаг (самоисправляется на следующем pre-step).
