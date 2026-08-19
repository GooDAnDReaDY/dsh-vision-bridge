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
      const [status, setStatus] = react.useState(null)
      const [saving, setSaving] = react.useState(false)

      const load = async () => {
        try {
          const [cfg, list] = await Promise.all([api('GET'), fetchModels()])
          setModels(list)
          setProvider(cfg.data && cfg.data.provider ? cfg.data.provider : '')
          setModel(cfg.data && cfg.data.model ? cfg.data.model : '')
          setSubmittedProvider(cfg.data && cfg.data.provider ? cfg.data.provider : '')
          setSubmittedModel(cfg.data && cfg.data.model ? cfg.data.model : '')
          if (list.length === 0) setErr(t('failed'))
          setLoaded(true)
        } catch (e) {
          setErr(String((e && e.message) || e))
          setLoaded(true)
        }
      }
      react.useEffect(() => { load() }, [])

      const dirty = provider !== submittedProvider || model !== submittedModel
      const providers = Array.from(new Set(models.map((m) => String(m.provider))))
      const modelsForProvider = provider ? models.filter((m) => m.provider === provider) : []

      const save = async () => {
        if ((provider && !model) || (!provider && model)) {
          setStatus({ kind: 'err', msg: t('reqBoth') })
          return
        }
        setSaving(true); setStatus(null)
        try {
          const res = await api('POST', { provider, model })
          if (!res.ok) {
            const m = (res.data && (res.data.error || res.data.message)) || (res.status + '')
            throw new Error(typeof m === 'string' ? m : JSON.stringify(m))
          }
          setSubmittedProvider(provider); setSubmittedModel(model)
          setStatus({ kind: 'ok', msg: t('saved') })
        } catch (e) {
          setStatus({ kind: 'err', msg: String((e && e.message) || e) || t('failed') })
        } finally { setSaving(false) }
      }
      const reset = async () => {
        setSaving(true); setStatus(null)
        try {
          const res = await api('POST', { provider: '', model: '' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          setProvider(''); setModel('')
          setSubmittedProvider(''); setSubmittedModel('')
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
    }
    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
