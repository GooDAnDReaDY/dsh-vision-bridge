# 📦 @goodandready/dsh-vision-bridge

<div align="center">

<h3>Универсальный мост зрения, мультимодальный адаптер и набор из 27 инструментов компьютерного зрения для DeepSeek Harness</h3>

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

**`dsh-vision-bridge`** — мощнейший мультимодальный комбайн для **DeepSeek Harness**.

Плагин решает две ключевые задачи:
1. **Универсальный мост зрения**: когда пользователь отправляет изображения, схемы или PDF-документы в **чисто текстовые LLM** (например, `deepseek-v4-flash`, `deepseek-chat`), плагин автоматически перехватывает вложения, запрашивает структурированное визуальное описание у выделенной Vision-модели (GPT-4o, Claude 3.5 Sonnet, Qwen2.5-VL, Gemini 2.0 Flash) и внедряет его в контекст промпта — полностью исключая ошибку `does not support image input`.
2. **27 инструментов компьютерного зрения для агента**: даёт агентам богатый набор тулов (OCR, VQA, координатное заземление, парсинг UI-интерфейсов, извлечение страниц PDF, пиксельный diff и батч-обработка).

```mermaid
graph LR
    subgraph Input [Вложения в сообщении]
        Attach[🖼️ Изображения / Скриншоты / PDF] --> Check{Модель чата поддерживает зрение?}
    end

    subgraph Transparent [Прозрачный мост зрения]
        Check -->|Да: Нативная VLM| Pass[Прямой запрос к модели]
        Check -->|Нет: Текстовая LLM| Interceptor[Перехватчик Vision Bridge]
        Interceptor --> VisionRouter{Маршрутизатор каналов зрения}
        VisionRouter -->|Канал 1| V1[GPT-4o / Claude 3.5 Sonnet]
        VisionRouter -->|Канал 2| V2[Qwen2.5-VL / Gemini Flash]
        VisionRouter -->|Оффлайн OCR| V3[Локальный движок OCR]
        V1 --> Structured[Структурированные визуальные улики]
        V2 --> Structured
        V3 --> Structured
        Structured --> Fuse[Инъекция в промпт и слияние контекста]
    end

    subgraph Execution [Генерация ответа]
        Pass --> LLM[Ответ модели в диалоге]
        Fuse --> LLM
    end

    style Input fill:#1e1e2e,stroke:#89b4fa,stroke-width:2px,color:#cdd6f4
    style Transparent fill:#181825,stroke:#cba6f7,stroke-width:2px,color:#cdd6f4
    style Execution fill:#11111b,stroke:#a6e3a1,stroke-width:2px,color:#cdd6f4
```

---

## 🛠️ Полная таблица 27 инструментов агента

`dsh-vision-bridge` регистрирует 27 специализированных инструментов в `ctx.tools`:

| Имя инструмента | Назначение | Ключевые параметры |
|---|---|---|
| `describe_image` | Общее смысловое описание и аннотирование изображения | `image_path`, `detail_level` |
| `read_image` | Прямое чтение текста с сохранением естественного порядка | `image_path`, `language` |
| `vision_ocr` | Высокоточное облачное оптическое распознавание символов | `image_path`, `detect_orientation` |
| `vision_ocr_local` | 100% оффлайн локальный движок OCR | `image_path` |
| `vision_long_ocr` | Распознавание сложных многоколоночных документов | `image_path`, `preserve_layout` |
| `vision_pdf_pages` | Извлечение страниц PDF, постраничный рендеринг и OCR | `pdf_path`, `pages`, `dpi` |
| `vision_describe_structured` | Извлечение структурированного JSON (объекты, текст, цвета) | `image_path`, `schema` |
| `vision_vqa` | Визуальные ответы на вопросы по выделенным областям | `image_path`, `question`, `bbox` |
| `vision_ground` | Определение координат и bounding box объектов | `image_path`, `query` |
| `vision_crop` | Динамическая обрезка картинки по координатам или точкам | `image_path`, `bbox`, `target_path` |
| `vision_detect` | Детекция объектов, подсчёт и классификация | `image_path`, `categories` |
| `vision_compare` | Семантическое сравнение нескольких изображений | `image_paths`, `aspects` |
| `vision_pixel_diff` | Попиксельное сравнение визуальной регрессии | `image_a`, `image_b`, `threshold` |
| `vision_ui_layout` | Парсинг UI-разметки, иерархии кнопок и элементов | `image_path`, `framework` |
| `vision_translate_image` | Перевод текста прямо на изображении | `image_path`, `target_lang` |
| `vision_colors` | Анализ цветовой палитры и доминирующих контрастов | `image_path`, `palette_size` |
| `vision_extract_foreground` | Удаление фона и изоляция главного объекта | `image_path`, `output_path` |
| `vision_trace` | Трассировка линий, чертежей и векторных контуров | `image_path`, `smoothness` |
| `vision_html_screenshot` | Рендеринг фрагментов HTML/CSS в скриншот | `html_content`, `viewport` |
| `vision_video_describe` | Анализ ключевых кадров видео и таймлайн-сводка | `video_path`, `fps` |
| `vision_batch` | Параллельная батч-обработка группы картинок | `image_paths`, `task` |
| `vision_browser_snapshot` | Снимок экрана headless-браузера | `url`, `wait_selector` |
| `vision_browser_click` | Клик по визуальным координатам в браузере | `coordinate`, `element_text` |
| `vision_browser_navigate` | Визуальная навигация по веб-страницам | `url` |
| `vision_present` | Форматирование визуальных презентаций и подсветка | `image_path`, `highlights` |
| `vision_materialize` | Материализация и кэширование визуальных ассетов | `asset_ref` |
| `vision_page_persist` | Сохранение визуального контекста между сессиями | `session_id`, `state` |

---

## 🌐 Каналы зрения и поддерживаемые модели

Настройте приоритетные каналы в **Настройки → Vision Bridge**:
* **Канал 1 (Основной)**: `openai` (`gpt-4o`, `gpt-4o-mini`), `anthropic` (`claude-3-5-sonnet-20241022`), `gemini` (`gemini-2.0-flash`).
* **Канал 2 (Скоростной / Экономичный)**: `qwen` (`qwen2.5-vl-72b-instruct`), `deepinfra` (`Qwen/Qwen2-VL-7B-Instruct`), `siliconflow`.
* **Канал 3 (Оффлайн)**: локальный движок OCR.

---

## 📊 Производительность, кэширование и учёт затрат

* **Дисковый LRU-кэш улик**: одинаковые скриншоты мгновенно отдаются из кэша с **0 мс задержки и 0 затрат токенов**.
* **Мониторинг расходов**: статистика токенов и затрат доступна через `GET /dsh-vision-bridge/costs` и `GET /dsh-vision-bridge/stats`.
* **Встроенный бенчмарк**: тестирование задержек моделей через `GET /dsh-vision-bridge/bench`.

---

## 📦 Быстрая установка

```bash
dsh plugin --profile web add @goodandready/dsh-vision-bridge
```

---

## ⚙️ Пример конфигурации (`settings.yaml`)

```yaml
dsh-vision-bridge:
  enabled: true
  primaryChannel:
    provider: openai
    model: gpt-4o-mini
    keyEnv: OPENAI_API_KEY
  secondaryChannel:
    provider: deepinfra
    model: Qwen/Qwen2-VL-7B-Instruct
    keyEnv: DEEPINFRA_API_KEY
  cacheEnabled: true
  maxCacheMb: 250
  detailLevel: auto
  pdfDpi: 200
```

---

## 📄 Лицензия

MIT © [GooDAnDReaDY](https://github.com/GooDAnDReaDY)
