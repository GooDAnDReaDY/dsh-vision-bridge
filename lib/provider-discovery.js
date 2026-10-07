import { discoverOllamaVisionModels } from './channels.js'
import { FREE_VISION_PROVIDERS, bestEffort } from './vision-core.js'

export function setupProviderDiscovery(ctx, config) {
  if (config.autoDiscoverOllama !== false && config.autoLocalOllama !== false) {
    discoverOllamaVisionModels().then((models) => {
      for (const m of models) {
        const exists = config.channels.some((c) => c.type === 'ollama' && c.model === m.name)
        if (!exists) {
          config.channels.push({ type: 'ollama', baseURL: 'http://localhost:11434/v1', model: m.name })
        }
      }
    }).catch((_err) => {
      // non-blocking ollama probe failure
    })
  }

  if (config.autoFreeProviders !== false) {
    for (const fp of FREE_VISION_PROVIDERS) {
      const key = process.env[fp.envKey]
      if (!key || !key.trim()) continue
      const exists = config.channels.some((c) => c.type === fp.type && c.baseURL === fp.baseURL && c.model === fp.model)
      if (!exists) {
        config.channels.push({ type: fp.type, baseURL: fp.baseURL, model: fp.model, apiKey: key.trim() })
      }
    }
  }

  if (config.includeOAuthProviders !== false) {
    bestEffort('subscription.accountsProbe', () => {
      const subscription = ctx.get?.('subscription')
      if (subscription && typeof subscription.listAccounts === 'function') {
        // Future: iterate vendors
      }
    })
  }
}
