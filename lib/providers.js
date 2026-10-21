import { getPluginLogger } from './logger.js'

/**
 * #211: resolve a channel's key through apiKeyRef indirection. An explicit
 * channel apiKey always wins; otherwise the credential service (`resolveCred`)
 * is asked for the referenced name, falling back to the named environment
 * variable. Returns the channel unchanged when nothing resolves, so callers
 * can apply it transparently to every channel entry.
 */
export async function resolveChannelApiKey(channel, resolveCred, env = process.env, allowedEnvNames = null) {
  if (!channel || !channel.apiKeyRef) return channel
  if (typeof channel.apiKey === 'string' && channel.apiKey.trim()) return channel
  const name = String(channel.apiKeyRef).trim()
  if (!name) return channel
  let key = ''
  if (typeof resolveCred === 'function') {
    try { key = String((await resolveCred(name)) || '') } catch (err) { getPluginLogger().debug('[dsh-vision-bridge] resolveCred failed:', err?.message || err) }
  }
  if (!key && env && typeof env[name] === 'string') {
    if (!Array.isArray(allowedEnvNames) || allowedEnvNames.includes(name)) {
      key = env[name]
    }
  }
  if (!key.trim()) return channel
  return { ...channel, apiKey: key }
}

export const FREE_VISION_PROVIDERS = [
  { id: 'groq-free', name: 'Groq (free tier)', type: 'openai-compatible', baseURL: 'https://api.groq.com/openai/v1', model: 'llava-v1.5-7b-4096-preview', envKey: 'GROQ_API_KEY' },
  { id: 'together-free', name: 'Together (free tier)', type: 'openai-compatible', baseURL: 'https://api.together.xyz/v1', model: 'llava-hf/llava-1.5-7b-hf', envKey: 'TOGETHER_API_KEY' },
  { id: 'fireworks-free', name: 'Fireworks (free tier)', type: 'openai-compatible', baseURL: 'https://api.fireworks.ai/inference/v1', model: 'accounts/fireworks/models/llava-v1.5-7b-fw', envKey: 'FIREWORKS_API_KEY' },
]

