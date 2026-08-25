// dsh-vision-bridge — browser (client) half.
//
// Top-level Settings section: "Настройки → Vision" with a dropdown of vision
// models. Images attached to a conversation are described automatically at the
// agent boundary by the host half, so no composer action is needed here.
// State is fetched and persisted via the host's /dsh-vision-bridge API, so the
// card is self-contained and does not depend on the settings-scope machinery.
//
// Localization: the plugin registers its own en/ru dictionaries with the DSH
// locale service (ctx.locale.register) and resolves the "active" locale
// through ctx.locale.getSnapshot().active + ctx.locale.subscribe() via
// React.useSyncExternalStore, so the UI switches language live whenever the
// DSH UI locale changes (Settings → Language). Browser language is used only
// as a fallback when the locale service is unavailable.

window.__ModuleLoader__.load({
  id: '@goodandready/dsh-vision-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react = require('react')
    let react_jsx_runtime = require('react/jsx-runtime')

    // ---------------------------------------------------------------- css
    const css =
      '.vbr{display:flex;flex-direction:column;gap:12px;padding:16px 20px;color:var(--dsw-alias-label-primary);max-width:620px}' +
      '.vbr h2{font-size:16px;font-weight:600;margin:0}' +
      '.vbr p{margin:0;font-size:13px;line-height:1.45}' +
      '.vbr .hint{color:var(--dsw-alias-label-secondary)}' +
      '.vbr .err{color:var(--dsw-alias-state-error-primary)}' +
      '.vbr .ok{color:var(--dsw-alias-state-success-primary)}' +
      '.vbr label{font-size:13px;font-weight:500;display:block;margin-bottom:4px}' +
      '.vbr select, .vbr input[type=text]{width:100%;border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-input-major);border-radius:6px;padding:6px 8px;font-size:13px;min-height:32px;box-sizing:border-box}' +
      '.vbr .row{display:flex;gap:8px;align-items:center;margin-top:8px}' +
      '.vbr-chan{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px;margin-top:8px;display:flex;flex-direction:column;gap:6px}' +
      '.vbr button{font:inherit;cursor:pointer;border-radius:6px;padding:6px 14px;font-size:13px;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary)}' +
      '.vbr button.primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}' +
      '.vbr button:disabled{opacity:.5;cursor:default}'
    const tagId = 'dsh-vision-bridge/settings-card.module.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-vision-bridge'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------- i18n
    const NS = 'dsh-vision-bridge'

    const en = {
      title: 'Vision',
      subtitle: 'Images in chat are processed by the vision model you choose here. Leave both fields empty to auto-pick the first vision-capable model from the catalog.',
      provider: 'Vision provider',
      model: 'Vision model',
      auto: 'Auto',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      reset: 'Reset (auto)',
      failed: 'Failed to load/save',
      reqBoth: 'Pick both provider and model, or leave both empty for auto',
      modelInvalid: 'Model does not accept images',
      current: 'Current: {provider} / {model}',
      currentAuto: 'Auto (auto-pick)',
      noVisionModels: 'No vision models in the catalog (input: [text, image]) — add one in Settings → Models.',
      loading: '…',
      mode: 'Mode',
      modeHybrid: 'Hybrid (auto-rewrite + tools)',
      modeLlm: 'LLM only (auto-rewrite, tools still available)',
      modeTools: 'Tools only (no auto-rewrite, model must call describe_image)',
      describeStrategy: 'Describe strategy',
      strategyAuto: 'Auto (use vision LLM)',
      strategyLlm: 'Vision LLM',
      strategyOcrLocal: 'Local OCR (reserved)',
      strategyCacheOnly: 'Cache only (no network)',
      escalation: 'Escalation',
      escalationSimple: 'Simple only (one pass)',
      escalationAuto: 'Auto-escalate (second pass on complex images)',
      advanced: 'Advanced',
      channels: 'Channels',
      addChannel: 'Add channel',
      remove: 'Remove',
      testVision: 'Test vision',
      testing: 'Testing…',
      testOk: 'OK ({ms}ms)',
      testFail: 'Failed: {err}',
      type: 'Type',
      baseURL: 'Base URL',
      apiKey: 'API key',
      model: 'Model',
      protocol: 'Protocol',
      protocolOpenaiChat: 'openai-chat',
      protocolOpenaiResponses: 'openai-responses',
      requestTemplate: 'Request template',
      responsePath: 'Response path',
      keyOk: 'key OK',
      keyMissing: 'no key',
      keyHidden: 'unknown',
      empty: '-',
    }
    const ru = {
      title: 'Vision',
      subtitle: 'Картинки в чате автоматически обрабатывает выбранная vision-модель. Можешь оставить поля пустыми — автоподбор первой vision-модели из каталога.',
      provider: 'Провайдер vision',
      model: 'Vision-модель',
      auto: 'Авто',
      save: 'Сохранить',
      saving: 'Сохранение…',
      saved: 'Сохранено',
      reset: 'Сброс (авто)',
      failed: 'Не удалось загрузить/сохранить',
      reqBoth: 'Укажите и провайдера, и модель — или оба пустые для автоподбора',
      modelInvalid: 'Модель не принимает изображения',
      current: 'Сейчас: {provider} / {model}',
      currentAuto: 'Авто (используется автоподбор)',
      noVisionModels: 'В каталоге нет vision-моделей (input: [text, image]) — добавьте vision-модель в Настройки → Модели.',
      loading: '…',
      mode: 'Режим',
      modeHybrid: 'Гибрид (авто-подмена + tools)',
      modeLlm: 'Только LLM (авто-подмена, tools доступны)',
      modeTools: 'Только tools (без авто-подмены, модель сама вызывает describe_image)',
      describeStrategy: 'Стратегия описания',
      strategyAuto: 'Авто (vision-LLM)',
      strategyLlm: 'Vision-LLM',
      strategyOcrLocal: 'Локальный OCR (резерв)',
      strategyCacheOnly: 'Только кэш (без сети)',
      escalation: 'Эскалация',
      escalationSimple: 'Простой (один проход)',
      escalationAuto: 'Авто-эскалация (второй проход для сложных)',
      advanced: 'Дополнительно',
      channels: 'Каналы',
      addChannel: 'Добавить канал',
      remove: 'Удалить',
      testVision: 'Проверить vision',
      testing: 'Проверка…',
      testOk: 'OK ({ms}ms)',
      testFail: 'Ошибка: {err}',
      type: 'Тип',
      baseURL: 'Базовый URL',
      apiKey: 'API ключ',
      model: 'Модель',
      protocol: 'Протокол',
      protocolOpenaiChat: 'openai-chat',
      protocolOpenaiResponses: 'openai-responses',
      requestTemplate: 'Шаблон запроса',
      responsePath: 'Путь ответа',
      keyOk: 'ключ задан',
      keyMissing: 'нет ключа',
      keyHidden: 'неизвестно',
      empty: '-',
    }
    }

    function useActiveLocale(ctx) {
      return react.useSyncExternalStore(
        react.useMemo(() => (cb) => (ctx && ctx.locale ? ctx.locale.subscribe(cb) : () => {}), [ctx]),
        react.useCallback(() => {
          if (ctx && ctx.locale) {
            const active = ctx.locale.getSnapshot().active
            if (typeof active === 'string' && active) return active
          }
          return typeof navigator !== 'undefined' ? String(navigator.language || '').slice(0, 2) : ''
        }, [ctx])
      )
    }

    function makeT(DICT, fallbackKeys) {
      return (key, vars) => {
        let s = (DICT && DICT[key]) || (fallbackKeys && fallbackKeys[key]) || key
        if (vars) {
          for (const k of Object.keys(vars)) s = String(s).replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k]))
        }
        return s
      }
    }

    // -------------------------------------------------------------- helpers
    async function api(method, body) {
      const res = await fetch('/dsh-vision-bridge/config', {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      })
      let data = null
      try { data = await res.json() } catch {}
      return { ok: res.ok, status: res.status, data }
    }
    async function fetchModels() {
      try {
        const res = await fetch('/dsh-vision-bridge/models', { cache: 'no-store' })
        if (!res.ok) return []
        const data = await res.json()
        const all = (data && Array.isArray(data.models)) ? data.models : []
        return all.filter((m) => m && m.vision)
      } catch { return [] }
    }

    // -------------------------------------------------------------- component
    function VisionSection(props) {
      const DICT = props.locale === 'ru' ? ru : en
      const t = makeT(DICT, en)
      const [models, setModels] = react.useState([])
      const [err, setErr] = react.useState(null)
      const [loaded, setLoaded] = react.useState(false)
      const [provider, setProvider] = react.useState('')
      const [model, setModel] = react.useState('')
      const [submittedProvider, setSubmittedProvider] = react.useState('')
      const [submittedModel, setSubmittedModel] = react.useState('')
      const [mode, setMode] = react.useState('hybrid')
      const [describeStrategy, setDescribeStrategy] = react.useState('auto')
      const [escalation, setEscalation] = react.useState('simple-only')
      const [submittedMode, setSubmittedMode] = react.useState('hybrid')
      const [submittedDescribeStrategy, setSubmittedDescribeStrategy] = react.useState('auto')
      const [submittedEscalation, setSubmittedEscalation] = react.useState('simple-only')
      const [channels, setChannels] = react.useState([])
      const [probe, setProbe] = react.useState([])
      const [status, setStatus] = react.useState(null)
      const [saving, setSaving] = react.useState(false)
      const [testing, setTesting] = react.useState(false)
      const [testResult, setTestResult] = react.useState(null)

      const load = async () => {
        try {
          const [cfg, list, ch] = await Promise.all([api('GET'), fetchModels(), fetch('/dsh-vision-bridge/channels', { cache: 'no-store' }).then((r) => r.json().catch(() => ({})))])
          setModels(list)
          const d = cfg.data || {}
          setProvider(d.provider ? d.provider : '')
          setModel(d.model ? d.model : '')
          setSubmittedProvider(d.provider ? d.provider : '')
          setSubmittedModel(d.model ? d.model : '')
          setMode(d.mode || 'hybrid')
          setDescribeStrategy(d.describeStrategy || 'auto')
          setEscalation(d.escalation || 'simple-only')
          setSubmittedMode(d.mode || 'hybrid')
          setSubmittedDescribeStrategy(d.describeStrategy || 'auto')
          setSubmittedEscalation(d.escalation || 'simple-only')
          if (Array.isArray(ch && ch.channels)) setChannels(ch.channels)
          if (Array.isArray(ch && ch.probe)) setProbe(ch.probe)
          if (list.length === 0) setErr(t('failed'))
          setLoaded(true)
        } catch (e) {
          setErr(String((e && e.message) || e))
          setLoaded(true)
        }
      }
      react.useEffect(() => { load() }, [])

      const saveChannels = async () => {
        setSaving(true); setStatus(null)
        try {
          const res = await fetch('/dsh-vision-bridge/channels', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({channels}),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status))
          if (Array.isArray(data.channels)) setChannels(data.channels)
          // refresh probe
          const pr = await fetch('/dsh-vision-bridge/channels', {cache: 'no-store'}).then((r) => r.json().catch(() => ({})))
          if (Array.isArray(pr && pr.probe)) setProbe(pr.probe)
          setStatus({kind: 'ok', msg: t('saved')})
        } catch (e) {
          setStatus({kind: 'err', msg: String((e && e.message) || e) || t('failed')})
        } finally { setSaving(false) }
      }
      const runTest = async () => {
        setTesting(true); setTestResult(null)
        try {
          const res = await fetch('/dsh-vision-bridge/test', {method: 'POST'})
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !(data && data.ok)) {
            const err = (data && (data.error || data.text)) || ('HTTP ' + res.status)
            setTestResult({ok: false, msg: t('testFail', {err: String(err)})})
            return
          }
          setTestResult({ok: true, msg: t('testOk', {ms: data.latencyMs})})
        } catch (e) {
          setTestResult({ok: false, msg: t('testFail', {err: String((e && e.message) || e)})})
        } finally { setTesting(false) }
      }
      const updateChannel = (i, patch) => {
        setChannels((prev) => prev.map((c, idx) => idx === i ? {...c, ...patch} : c))
      }
      const addChannel = (type) => {
        const seed = type === 'dsh-catalog' ? {type, provider: '', model: ''}
          : type === 'ollama' ? {type, baseURL: 'http://localhost:11434/v1', model: ''}
          : type === 'custom' ? {type, baseURL: '', model: '', requestTemplate: '', responsePath: ''}
          : {type, baseURL: '', model: ''}
        setChannels((prev) => [...prev, seed])
      }
      const removeChannel = (i) => {
        setChannels((prev) => prev.filter((_, idx) => idx !== i))
      }

      const dirty = provider !== submittedProvider
        || model !== submittedModel
        || mode !== submittedMode
        || describeStrategy !== submittedDescribeStrategy
        || escalation !== submittedEscalation
      const providers = Array.from(new Set(models.map((m) => String(m.provider))))
      const modelsForProvider = provider ? models.filter((m) => m.provider === provider) : []

      const save = async () => {
        if ((provider && !model) || (!provider && model)) {
          setStatus({ kind: 'err', msg: t('reqBoth') })
          return
        }
        setSaving(true); setStatus(null)
        try {
          const res = await api('POST', { provider, model, mode, describeStrategy, escalation })
          if (!res.ok) {
            const m = (res.data && (res.data.error || res.data.message)) || (res.status + '')
            throw new Error(typeof m === 'string' ? m : JSON.stringify(m))
          }
          setSubmittedProvider(provider); setSubmittedModel(model)
          setSubmittedMode(mode); setSubmittedDescribeStrategy(describeStrategy); setSubmittedEscalation(escalation)
          setStatus({ kind: 'ok', msg: t('saved') })
        } catch (e) {
          setStatus({ kind: 'err', msg: String((e && e.message) || e) || t('failed') })
        } finally { setSaving(false) }
      }
      const reset = async () => {
        setSaving(true); setStatus(null)
        try {
          const res = await api('POST', { provider: '', model: '', mode: '', describeStrategy: '', escalation: '' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          setProvider(''); setModel('')
          setSubmittedProvider(''); setSubmittedModel('')
          setMode('hybrid'); setSubmittedMode('hybrid')
          setDescribeStrategy('auto'); setSubmittedDescribeStrategy('auto')
          setEscalation('simple-only'); setSubmittedEscalation('simple-only')
          setStatus({ kind: 'ok', msg: t('reset') })
        } catch (e) {
          setStatus({ kind: 'err', msg: String((e && e.message) || e) || t('failed') })
        } finally { setSaving(false) }
      }

      const detail = submittedProvider && submittedModel
        ? t('current', { provider: submittedProvider, model: submittedModel })
        : t('currentAuto')

      return react_jsx_runtime.jsxs('div', { className: 'vbr', children: [
        react_jsx_runtime.jsx('h2', { children: t('title') }),
        react_jsx_runtime.jsx('p', { className: 'hint', children: t('subtitle') }),
        loaded ? react_jsx_runtime.jsxs('div', { children: [
          react_jsx_runtime.jsx('label', { children: t('mode') }),
          react_jsx_runtime.jsxs('select', {
            value: mode,
            onChange: (e) => setMode(e.target.value),
            children: [
              react_jsx_runtime.jsx('option', { value: 'hybrid', children: t('modeHybrid') }),
              react_jsx_runtime.jsx('option', { value: 'llm', children: t('modeLlm') }),
              react_jsx_runtime.jsx('option', { value: 'tools', children: t('modeTools') }),
            ],
          }),
        ] }) : null,
        loaded ? react_jsx_runtime.jsxs('div', { children: [
          react_jsx_runtime.jsx('label', { children: t('describeStrategy') }),
          react_jsx_runtime.jsxs('select', {
            value: describeStrategy,
            onChange: (e) => setDescribeStrategy(e.target.value),
            children: [
              react_jsx_runtime.jsx('option', { value: 'auto', children: t('strategyAuto') }),
              react_jsx_runtime.jsx('option', { value: 'llm', children: t('strategyLlm') }),
              react_jsx_runtime.jsx('option', { value: 'ocr-local', children: t('strategyOcrLocal') }),
              react_jsx_runtime.jsx('option', { value: 'cache-only', children: t('strategyCacheOnly') }),
            ],
          }),
        ] }) : null,
        loaded ? react_jsx_runtime.jsxs('div', { children: [
          react_jsx_runtime.jsx('label', { children: t('escalation') }),
          react_jsx_runtime.jsxs('select', {
            value: escalation,
            onChange: (e) => setEscalation(e.target.value),
            children: [
              react_jsx_runtime.jsx('option', { value: 'simple-only', children: t('escalationSimple') }),
              react_jsx_runtime.jsx('option', { value: 'auto-escalate', children: t('escalationAuto') }),
            ],
          }),
        ] }) : null,
        !loaded
          ? react_jsx_runtime.jsx('p', { className: 'hint', children: t('loading') })
          : null,
        err
          ? react_jsx_runtime.jsx('p', { className: 'err', children: t('failed') + ': ' + err })
          : null,
        loaded && models.length === 0
          ? react_jsx_runtime.jsx('p', { className: 'err', children: t('noVisionModels') })
          : null,
        loaded && models.length > 0 ? react_jsx_runtime.jsxs('div', { children: [
          react_jsx_runtime.jsx('label', { children: t('provider') }),
          react_jsx_runtime.jsxs('select', {
            value: provider,
            onChange: (e) => { setProvider(e.target.value); setModel('') },
            children: [
              react_jsx_runtime.jsx('option', { value: '', children: t('auto') }),
              providers.map((p) => react_jsx_runtime.jsx('option', { value: p, children: p }, p)),
            ],
          }),
        ] }) : null,
        loaded && provider && modelsForProvider.length > 0 ? react_jsx_runtime.jsxs('div', { children: [
          react_jsx_runtime.jsx('label', { children: t('model') }),
          react_jsx_runtime.jsxs('select', {
            value: model,
            onChange: (e) => setModel(e.target.value),
            children: [
              react_jsx_runtime.jsx('option', { value: '', children: t('auto') }),
              modelsForProvider.map((m) => react_jsx_runtime.jsx('option', { value: m.model, children: m.model }, m.model)),
            ],
          }),
        ] }) : null,
        react_jsx_runtime.jsx('p', { className: 'hint', children: detail }),
        status ? react_jsx_runtime.jsx('p', { className: status.kind === 'ok' ? 'ok' : 'err', children: status.msg }) : null,
        react_jsx_runtime.jsxs('div', { className: 'row', children: [
          react_jsx_runtime.jsx('button', { className: 'primary', disabled: saving || !dirty, onClick: save, children: saving ? t('saving') : t('save') }),
          (submittedProvider || submittedModel) ? react_jsx_runtime.jsx('button', { disabled: saving, onClick: reset, children: t('reset') }) : null,
        ] }),
        loaded ? react_jsx_runtime.jsxs('div', { children: [
          react_jsx_runtime.jsx('h2', { children: t('channels') }),
          channels.length === 0 ? react_jsx_runtime.jsx('p', { className: 'hint', children: t('empty') }) : null,
          channels.map((c, i) => {
            const dot = probe[i]
            const dotColor = dot && dot.hasKey ? 'ok' : (dot && dot.key === '' && (c.type === 'ollama' || c.type === 'dsh-catalog') ? 'ok' : 'err')
            const dotText = dot && dot.hasKey ? t('keyOk') : (dot && dot.key === '' && (c.type === 'ollama' || c.type === 'dsh-catalog') ? t('keyOk') : t('keyMissing'))
            return react_jsx_runtime.jsxs('div', { className: 'vbr-chan', children: [
              react_jsx_runtime.jsxs('div', { className: 'row', children: [
                react_jsx_runtime.jsxs('select', {
                  value: c.type || 'openai-compatible',
                  onChange: (e) => updateChannel(i, {type: e.target.value}),
                  children: [
                    react_jsx_runtime.jsx('option', { value: 'dsh-catalog', children: 'dsh-catalog' }),
                    react_jsx_runtime.jsx('option', { value: 'openai-compatible', children: 'openai-compatible' }),
                    react_jsx_runtime.jsx('option', { value: 'ollama', children: 'ollama' }),
                    react_jsx_runtime.jsx('option', { value: 'custom', children: 'custom' }),
                  ],
                }),
                react_jsx_runtime.jsx('button', { disabled: saving, onClick: () => removeChannel(i), children: t('remove') }),
              ] }),
              (c.type === 'openai-compatible' || c.type === 'custom' || c.type === 'ollama') ? react_jsx_runtime.jsxs('div', { children: [
                react_jsx_runtime.jsx('label', { children: t('baseURL') }),
                react_jsx_runtime.jsx('input', { type: 'text', value: c.baseURL || '', onChange: (e) => updateChannel(i, {baseURL: e.target.value}) }),
              ] }) : null,
              react_jsx_runtime.jsxs('div', { children: [
                react_jsx_runtime.jsx('label', { children: t('model') }),
                react_jsx_runtime.jsx('input', { type: 'text', value: c.model || '', onChange: (e) => updateChannel(i, {model: e.target.value}) }),
              ] }),
              c.type === 'dsh-catalog' ? react_jsx_runtime.jsxs('div', { children: [
                react_jsx_runtime.jsx('label', { children: t('provider') }),
                react_jsx_runtime.jsx('input', { type: 'text', value: c.provider || '', onChange: (e) => updateChannel(i, {provider: e.target.value}) }),
              ] }) : null,
              c.type !== 'dsh-catalog' && c.type !== 'ollama' ? react_jsx_runtime.jsxs('div', { children: [
                react_jsx_runtime.jsx('label', { children: t('apiKey') }),
                react_jsx_runtime.jsx('input', { type: 'text', value: c.apiKey || '', onChange: (e) => updateChannel(i, {apiKey: e.target.value}) }),
              ] }) : null,
              c.type === 'custom' ? react_jsx_runtime.jsxs('div', { children: [
                react_jsx_runtime.jsx('label', { children: t('requestTemplate') }),
                react_jsx_runtime.jsx('input', { type: 'text', value: c.requestTemplate || '', onChange: (e) => updateChannel(i, {requestTemplate: e.target.value}) }),
              ] }) : null,
              c.type === 'custom' ? react_jsx_runtime.jsxs('div', { children: [
                react_jsx_runtime.jsx('label', { children: t('responsePath') }),
                react_jsx_runtime.jsx('input', { type: 'text', value: c.responsePath || '', onChange: (e) => updateChannel(i, {responsePath: e.target.value}) }),
              ] }) : null,
              react_jsx_runtime.jsx('p', { className: dotColor, children: dotText }),
            ] }, i)
          }),
          react_jsx_runtime.jsxs('div', { className: 'row', children: [
            react_jsx_runtime.jsxs('select', {
              id: 'vbr-add-type',
              defaultValue: 'openai-compatible',
              children: [
                react_jsx_runtime.jsx('option', { value: 'dsh-catalog', children: 'dsh-catalog' }),
                react_jsx_runtime.jsx('option', { value: 'openai-compatible', children: 'openai-compatible' }),
                react_jsx_runtime.jsx('option', { value: 'ollama', children: 'ollama' }),
                react_jsx_runtime.jsx('option', { value: 'custom', children: 'custom' }),
              ],
            }),
            react_jsx_runtime.jsx('button', {
              onClick: () => {
                const sel = document.getElementById('vbr-add-type')
                addChannel(sel ? sel.value : 'openai-compatible')
              },
              children: t('addChannel'),
            }),
            react_jsx_runtime.jsx('button', { className: 'primary', disabled: saving, onClick: saveChannels, children: t('save') }),
          ] }),
          react_jsx_runtime.jsxs('div', { className: 'row', children: [
            react_jsx_runtime.jsx('button', { disabled: testing, onClick: runTest, children: testing ? t('testing') : t('testVision') }),
            testResult ? react_jsx_runtime.jsx('p', { className: testResult.ok ? 'ok' : 'err', children: testResult.msg }) : null,
          ] }),
        ] }) : null,
      ] })
    }

    // -------------------------------------------------------------- apply
    function apply(ctx) {
      // Register the plugin's own dictionaries so the DSH locale service can
      // bind its namespace and the UI follows the active UI language live.
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'dsh-vision-bridge: dictionaries')
      function useLocale() {
        return useActiveLocale(ctx)
      }
      // Single top-level Settings section.
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'vision',
            order: 25,
            label: () => 'Vision',
          },
          (props) => react.createElement(VisionSection, { ...props, locale: useLocale() }),
        ),
      )
      // ponytail: composer-bar selector is best-effort. Some DSH versions may not
      // expose composer.action; we wrap inject in try/catch and log nothing on
      // failure (no broken UI on older DSH). Replace with proper slot detection
      // once the host exposes a capability list.
      function submittedModeLabel() {
        try {
          // ponytail: cheap heuristic to surface current mode in composer label.
          // Reads any select with one of the known values; falls back to 'auto'.
          if (typeof document === 'undefined' || !document.querySelectorAll) return ''
          const sels = document.querySelectorAll('select')
          for (const s of sels) {
            const v = s && s.value
            if (v === 'hybrid' || v === 'llm' || v === 'tools') return v
          }
          return ''
        } catch (_e) { return '' }
      }
      try {
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          ctx.slots.inject('composer.action', () =>
            ctx.slots.register(
              {
                name: 'composer.action',
                id: 'vision-bridge-mode',
                order: 30,
                label: () => 'Vision: ' + (submittedModeLabel() || 'auto'),
              },
              () => null,
            ),
          )
        }
      } catch (_e) {
        // slot unavailable — graceful fallback to Settings card
      }
    }
    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
