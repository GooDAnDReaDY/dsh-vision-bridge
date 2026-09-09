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
  - Карточка плагина в слоте `settings.plugin.item` (с фоллбэком на `settings.section`).
  - Привязка к `ctx.settingsScope` (`namespace: 'dsh-vision-bridge'`).
- **Инструменты агента (Tools)**:
  - 30+ инструментов (`describe_image`, `vision_ocr`, `vision_extract_formula`, `vision_extract_table`, `vision_scan_barcode`, `vision_ui_flow` и др.).

## 3. Визуальное направление и стили
- Нативный минималистичный UI, полностью повторяющий системные токены DSH (`--dsw-alias-*`).
- Кнопки в строке ввода (`.vbr-input-btn`): компактные бейджи высотой 28px, не перегружающие интерфейс.
- Карточка настроек: аккордеон с четким разделением каналов, ключей и стратегий.

## 4. Контракт безопасности и данных
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
