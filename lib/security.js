import { createHash } from 'node:crypto'
import { resolve, sep, dirname, posix } from 'node:path'
import { realpathSync } from 'node:fs'

export function isLoopbackAddress(ip) {
  if (!ip || typeof ip !== 'string') return false
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true
  if (/^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip) && ip.split('.').every((part) => Number(part) <= 255)) return true
  return false
}

export function isTrustedSettingsRequest(request, expectedToken) {
  if (!request || !request.headers || typeof request.headers !== 'object') return false
  const headers = request.headers

  // Cross-site requests are unconditionally forbidden
  if (headers['sec-fetch-site'] === 'cross-site') return false

  // Reject invalid or mismatched origin when provided (CSRF protection)
  const origin = headers['origin']
  const host = headers['host']
  if (origin !== undefined) {
    if (origin === 'null' || !origin) return false
    try {
      const originUrl = new URL(origin)
      if (host && originUrl.host !== host) return false
    } catch {
      return false
    }
  }

  // 1. Bearer token in Authorization header
  // #349: Must validate against configured secret/token; arbitrary bearer strings are rejected.
  const tokenCandidate = (typeof expectedToken === 'string' && expectedToken)
    || process.env.DSH_AUTH_TOKEN
    || process.env.DSH_TOKEN
    || null

  const auth = headers['authorization']
  let tokenAuthenticated = false
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const bearer = auth.slice(7).trim()
    if (tokenCandidate && bearer && bearer === tokenCandidate) {
      tokenAuthenticated = true
    }
  }

  // 2. Cookie containing authentication token
  // #349: Substring check alone is insufficient; must match configured token secret.
  const cookie = headers['cookie']
  if (typeof cookie === 'string' && tokenCandidate) {
    const match = cookie.match(/(?:^|;\s*)(?:token|dsh-auth|dsh_token)=([^;]+)/)
    if (match && match[1] === tokenCandidate) {
      tokenAuthenticated = true
    }
  }

  if (tokenAuthenticated) {
    return true
  }

  const ip = request.socket?.remoteAddress || request.connection?.remoteAddress || ''
  const hasRemote = Boolean(ip && typeof ip === 'string')
  const isLoopback = hasRemote && isLoopbackAddress(ip)

  // #375: Non-loopback remote callers require explicit token authentication.
  // Spoofable browser headers like 'sec-fetch-site: same-origin' cannot bypass this for network clients.
  if (hasRemote && !isLoopback) {
    return false
  }

  // 3. Browser same-origin navigation / fetch (#308)
  if (headers['sec-fetch-site'] === 'same-origin') {
    if (origin && host) {
      try {
        const originUrl = new URL(origin)
        if (originUrl.host === host) return true
      } catch {
        return false
      }
    } else {
      return true
    }
  }

  // 4. Socket loopback remote address (#308)
  if (isLoopback) {
    return true
  }

  return false
}

export function maskApiKey(key) {
  if (!key || typeof key !== 'string') return ''
  const trimmed = key.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 8) return '********'
  return trimmed.slice(0, 4) + '...' + trimmed.slice(-4)
}

export function isMaskedKey(key) {
  return typeof key === 'string' && (key.includes('...') || key === '********')
}

export function resolveInside(baseDir, candidatePath) {
  if (!baseDir || typeof baseDir !== 'string') {
    throw new Error('resolveInside: base directory must be a non-empty string')
  }
  const resolvedBase = resolve(baseDir)
  const candidateStr = String(candidatePath ?? '').trim()
  if (!candidateStr) return resolvedBase

  const resolvedTarget = resolve(resolvedBase, candidateStr)
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + sep)) {
    throw new Error('Path escapes directory: ' + candidatePath)
  }

  // Symlink resolution and realpath boundary check
  let realBase = resolvedBase
  try {
    realBase = realpathSync(resolvedBase)
  } catch {
    // Base directory may not exist in mock/unit test environments
  }

  let realTarget = null
  let targetExists = false
  try {
    realTarget = realpathSync(resolvedTarget)
    targetExists = true
  } catch (targetErr) {
    if (targetErr?.code !== 'ENOENT') {
      throw targetErr
    }
  }

  if (targetExists && realTarget) {
    if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) {
      throw new Error('Path escapes directory (symlink target): ' + candidatePath)
    }
  } else {
    let curr = dirname(resolvedTarget)
    while (curr === resolvedBase || curr.startsWith(resolvedBase + sep)) {
      let realCurr = null
      let currExists = false
      try {
        realCurr = realpathSync(curr)
        currExists = true
      } catch (ancestorErr) {
        if (ancestorErr?.code === 'ENOENT') {
          const parent = dirname(curr)
          if (parent === curr) break
          curr = parent
          continue
        }
        throw ancestorErr
      }
      if (currExists && realCurr) {
        if (realCurr !== realBase && !realCurr.startsWith(realBase + sep)) {
          throw new Error('Path escapes directory (symlink ancestor): ' + candidatePath)
        }
        break
      }
      break
    }
  }

  return resolvedTarget
}

function normalizeSlashes(p) {
  return String(p || '').replaceAll('\\', '/')
}

function resolveNorm(p) {
  const s = normalizeSlashes(p)
  const m = s.match(/^([a-zA-Z]:)(\/.*)?$/)
  if (m) {
    const drive = m[1].toUpperCase()
    const rest = m[2] || '/'
    return drive + posix.normalize(rest)
  }
  return posix.resolve(s)
}

export function isPathAllowed(path, allowedDirs) {
  if (!Array.isArray(allowedDirs) || allowedDirs.length === 0) return true
  if (!path || typeof path !== 'string') return false
  const target = resolveNorm(path)
  return allowedDirs.some((d) => {
    if (!d || typeof d !== 'string') return false
    const base = resolveNorm(d)
    const cleanBase = base.replace(/\/+$/, '')
    if (target === cleanBase || target.startsWith(cleanBase + '/')) {
      try {
        const sysTarget = resolve(path)
        const sysBase = resolve(d)
        let realBase = sysBase
        try { realBase = realpathSync(sysBase) } catch { /* ignore non-existent dir in tests */ }
        try {
          const realTarget = realpathSync(sysTarget)
          return realTarget === realBase || realTarget.startsWith(realBase + sep)
        } catch (e) {
          if (e?.code === 'ENOENT') return true
        }
      } catch {
        return true
      }
      return true
    }
    return false
  })
}

export function maskSecretsInError(msg) {
  if (typeof msg !== 'string') return msg
  return msg.replace(/(api[_-]?key\s*[:=]\s*)[^,\s]+/gi, '$1***')
}

/** True for IPv4/IPv6 addresses in loopback, private, link-local, CGNAT or
 *  unspecified ranges — hosts a server-side fetch must not contact (#202).
 *  Recognizes IPv4-mapped/translated forms too: ::ffff:a.b.c.d (dotted and
 *  hex) and the NAT64 prefix 64:ff9b::/96 (conservatively blocked). */
export function isPrivateIp(ip) {
  const s = String(ip || '').toLowerCase()
  if (s.includes(':')) {
    if (s === '::' || s === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(s)) return true // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(s)) return true // fe80::/10 link-local
    if (/^64:ff9b:/.test(s)) return true // 64:ff9b::/96 NAT64 — block conservatively
    // ::ffff:0:0/96 embeds an IPv4 address — check the embedded host.
    const mappedDotted = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
    if (mappedDotted) return isPrivateIp(mappedDotted[1])
    const mappedHex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16)
      const lo = parseInt(mappedHex[2], 16)
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return false
  }
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const octets = m.slice(1).map(Number)
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * #202: gate server-side fetches of model-supplied URLs. Refuses non-http(s)
 * schemes and hosts resolving into private/loopback/link-local ranges. When
 * `allowedHosts` is non-empty, only those exact hostnames are accepted and no
 * DNS lookup is performed. `opts.lookup` is injectable for offline tests.
 */
export async function isSafeFetchUrl(raw, opts = {}) {
  const allowList = Array.isArray(opts.allowedHosts)
    ? opts.allowedHosts.map((h) => String(h).toLowerCase().trim()).filter(Boolean)
    : []
  let u
  try { u = new URL(String(raw || '')) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = (u.hostname || '').toLowerCase()
  if (!host) return false
  if (allowList.length > 0) return allowList.includes(host)
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const { isIP } = await import('node:net')
  if (isIP(bare)) return !isPrivateIp(bare)
  const lookup = opts.lookup || (await import('node:dns')).promises.lookup
  try {
    const records = await lookup(bare, { all: true, verbatim: true })
    if (!records || records.length === 0) return false
    return records.every((r) => !isPrivateIp(r.address))
  } catch {
    return false
  }
}

/**
 * Error code marking a fetch-policy refusal. Callers that treat per-source read
 * failures as skippable must re-throw this one: a refused hop is a security
 * decision, not a transient read error (#258 review).
 */
export const FETCH_POLICY_CODE = 'EFETCH_POLICY'

/**
 * #202: fetch with the fetch policy re-applied to every redirect hop. A
 * public URL that 302s to a private address is refused instead of followed.
 * Known residual limitation: a DNS-rebinding host can pass validation and
 * then resolve to an internal address inside fetch itself (validation and
 * transfer resolve DNS independently); closing that fully requires pinning
 * the validated address, tracked for the docs/security sweep (#207).
 * `opts.fetch` is injectable for offline tests.
 */
export async function safeFetch(raw, opts = {}) {
  let url = String(raw || '')
  const doFetch = opts.fetch || fetch
  const init = opts.init || {}
  const maxRedirects = opts.maxRedirects == null ? 3 : opts.maxRedirects
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!(await isSafeFetchUrl(url, opts))) {
      throw Object.assign(new Error(`URL refused by fetch policy (#202): ${url}`), { code: FETCH_POLICY_CODE })
    }
    const res = await doFetch(url, { ...init, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res
      url = new URL(location, url).toString()
      continue
    }
    return res
  }
  throw new Error('safeFetch: too many redirects (#202)')
}

/**
 * Mask PII (emails, phones, names) in text.
 * ponytail: regex-based, not NER — catches common patterns. Upgrade to NER model if accuracy matters.
 */
export function maskPII(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
    .replace(/\+?\d[\d\s()-]{7,}\d/g, '[PHONE]')
    .replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, '[NAME]')
}

/**
 * Mask system paths and IP addresses in text.
 */
export function maskSystemPaths(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/\/(?:home|root|Users|var|etc|tmp|opt|mnt)\/[^\s,;)}\]]+/g, '[PATH]')
    .replace(/[A-Z]:\\[^\s,;)}\]]+/g, '[PATH]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')
    .replace(/\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, '[IP]')
}

/**
 * #358: Derive a non-secret stable label for quota attribution without exposing raw key characters.
 */
export function deriveKeyLabel(apiKey, apiKeyRef) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return '(no key)'
  }
  const hash = createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 8)
  if (apiKeyRef && typeof apiKeyRef === 'string' && apiKeyRef.trim()) {
    return `${apiKeyRef.trim()}#${hash}`
  }
  return `key#${hash}`
}

export const MAX_CONFIG_BODY_BYTES = 512 * 1024 // 512 KB
export const MAX_BATCH_BODY_BYTES = 1024 * 1024  // 1 MB

/**
 * #359: Read HTTP request body with a strict byte limit and fail-fast 413.
 * Checks Content-Length upfront if declared, stops consuming after limit is reached
 * without accumulating excessive memory on chunked or undeclared streams.
 */
export async function readBoundedBody(req, limit = MAX_CONFIG_BODY_BYTES) {
  const declared = Number(req.headers?.['content-length'] || 0)
  if (declared > limit) {
    const err = new Error(`payload of ${declared} bytes exceeds the ${limit} limit`)
    err.statusCode = 413
    throw err
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let total = 0
    let tooLarge = false
    let drained = 0
    const chunks = []

    const cleanup = () => {
      if (typeof req.removeListener === 'function') {
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.removeListener('error', onError)
      }
    }

    const fail = (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    const onData = (chunk) => {
      if (settled) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (tooLarge) {
        drained += buf.length
        if (drained > limit * 2) {
          if (typeof req.destroy === 'function') req.destroy()
        }
        return
      }
      if (total > limit) {
        tooLarge = true
        return
      }
      chunks.push(buf)
    }

    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      if (tooLarge) {
        const err = new Error(`payload exceeds the ${limit} limit`)
        err.statusCode = 413
        reject(err)
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    }

    const onError = (err) => {
      fail(err)
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

