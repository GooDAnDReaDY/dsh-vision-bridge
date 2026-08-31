# Group 1 — Routing & Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add circuit breaker, latency-based channel ordering, image compression, and OAuth provider integration to dsh-vision-bridge.

**Architecture:** Extend existing `channels.js` (circuit breaker + latency) and `index.js` (compression + OAuth + config). No new files. UI changes in `client.js`.

**Tech Stack:** Node.js 20+, sharp (optional, for compression), existing channels.js/index.js patterns.

## Global Constraints

- Plugin: `@goodandready/dsh-vision-bridge`
- Server: `migrate@192.168.1.111`, SSH key `C:\Users\vadim\.ssh\codex_migrate2`
- Plugin path: `/mnt/external/Project/DEV/dhsplugins/dsh-vision-bridge`
- Git wrapper: `/home/vadim/.ssh/bin/git-opencode`
- Working user: `vadim` (all git/project commands via `sudo -u vadim -H bash -lc`)
- No force push, no `--force`, no `--no-verify`
- Conventional Commits: `feat(channels): ...`, `fix(api): ...`, etc.
- sharp is optional — compression silently skipped if not installed
- All network errors non-fatal: next channel is tried
- Circuit breaker state is in-memory only (lost on restart) — acceptable for v1

---

### Task 1: Circuit Breaker State in channels.js

**Files:**
- Modify: `lib/channels.js` — add circuit breaker state tracking and check logic

**Interfaces:**
- Produces: `getCircuitState(key)`, `setCircuitState(key, state)`, `isCircuitOpen(key)` — used by Task 2 (runChannels) and Task 6 (API routes)

- [ ] **Step 1: Add circuit breaker state Map and helpers**

In `channels.js`, after the existing `channelKey()` function, add:

```js
// Circuit breaker: 3 consecutive failures → open 5 min → half-open → probe.
const CIRCUIT_OPEN_MS = 5 * 60 * 1000 // 5 minutes
const CIRCUIT_FAIL_THRESHOLD = 3

/**
 * Get or initialize circuit state for a channel key.
 * @returns {{failures:number, state:'closed'|'open'|'half-open', openUntil:number}}
 */
export function getCircuitState(states, key) {
  if (!states.has(key)) states.set(key, { failures: 0, state: 'closed', openUntil: 0 })
  return states.get(key)
}

/**
 * Record a successful call — reset circuit to closed.
 */
export function circuitSuccess(states, key) {
  const s = getCircuitState(states, key)
  s.failures = 0
  s.state = 'closed'
  s.openUntil = 0
}

/**
 * Record a failed call — increment failures, open if threshold reached.
 */
export function circuitFailure(states, key) {
  const s = getCircuitState(states, key)
  s.failures++
  if (s.failures >= CIRCUIT_FAIL_THRESHOLD) {
    s.state = 'open'
    s.openUntil = Date.now() + CIRCUIT_OPEN_MS
  }
}

/**
 * Check if circuit is open (channel should be skipped).
 * If open time elapsed, transition to half-open and allow one probe.
 */
export function isCircuitOpen(states, key) {
  const s = getCircuitState(states, key)
  if (s.state === 'closed') return false
  if (s.state === 'half-open') return false // allow probe
  // state === 'open'
  if (Date.now() >= s.openUntil) {
    s.state = 'half-open'
    return false // allow probe
  }
  return true // still open, skip
}
```

- [ ] **Step 2: Verify exports are correct**

Check that `getCircuitState`, `circuitSuccess`, `circuitFailure`, `isCircuitOpen` are exported.

- [ ] **Step 3: Commit**

```bash
git add lib/channels.js
git commit -m "feat(channels): add circuit breaker state tracking (#129)"
```

---

### Task 2: Integrate Circuit Breaker into runChannels

**Files:**
- Modify: `lib/channels.js` — `runChannels()` function

**Interfaces:**
- Consumes: `getCircuitState`, `circuitSuccess`, `circuitFailure`, `isCircuitOpen` from Task 1
- Produces: `circuitStates` Map passed via `ctx` — used by Task 6 (API routes)

- [ ] **Step 1: Add circuitStates to ctx parameter**

In `runChannels()`, add `ctx.circuitStates` support:

```js
export async function runChannels(channels, ctx) {
  const cooldowns = ctx.cooldowns instanceof Map ? ctx.cooldowns : new Map()
  const circuitStates = ctx.circuitStates instanceof Map ? ctx.circuitStates : new Map()
  const mode = ctx.fallback || 'sequential'
  const attempts = []
  // ... rest of function
```

- [ ] **Step 2: Add circuit breaker check before runChannel in sequential mode**

In the sequential loop, before calling `runChannel()`, add:

```js
  for (const channel of channels) {
    const key = channelKey(channel)
    // Circuit breaker check
    if (isCircuitOpen(circuitStates, key)) {
      attempts.push({channel: key, skipped: 'circuit-open'})
      continue
    }
    // Cooldown check (existing)
    const expiresAt = cooldowns.get(key) || 0
    if (Date.now() < expiresAt) {
      attempts.push({channel: key, skipped: 'cooldown'})
      continue
    }
    // ... existing runChannel call
```

- [ ] **Step 3: Add circuit breaker check in parallel-race mode**

In the parallel-race branch, filter out circuit-open channels:

```js
  if (mode === 'parallel-race') {
    const eligible = []
    for (const channel of channels) {
      const key = channelKey(channel)
      // Circuit breaker check
      if (isCircuitOpen(circuitStates, key)) {
        attempts.push({channel: key, skipped: 'circuit-open'})
        continue
      }
      const expiresAt = cooldowns.get(key) || 0
      if (Date.now() < expiresAt) { attempts.push({channel: key, skipped: 'cooldown'}); continue }
      eligible.push({channel, key})
    }
    // ... rest of parallel-race
```

- [ ] **Step 4: Record circuit success/failure after runChannel**

After `runChannel()` returns, update circuit state:

```js
    const attempt = await runChannel(channel, { /* ... */ })
    attempts.push({channel: key, ok: !!attempt.ok, reason: attempt.reason, status: attempt.status})
    if (attempt.ok) {
      circuitSuccess(circuitStates, key)
      return {ok: true, description: attempt.description, channel, attempts}
    }
    circuitFailure(circuitStates, key)
    if (ctx.cooldownMs > 0) {
      cooldowns.set(key, Date.now() + ctx.cooldownMs)
    }
```

- [ ] **Step 5: Commit**

```bash
git add lib/channels.js
git commit -m "feat(channels): integrate circuit breaker into runChannels (#129)"
```

---

### Task 3: Latency Tracking in channels.js

**Files:**
- Modify: `lib/channels.js` — add latency tracking helpers

**Interfaces:**
- Produces: `recordLatency(key, ms)`, `getAvgLatency(key)`, `getSortedChannels(channels, ctx)` — used by Task 4

- [ ] **Step 1: Add latency tracking helpers**

In `channels.js`, after circuit breaker functions:

```js
// Latency tracking: rolling window of last 10 calls per channel.
const LATENCY_WINDOW = 10

export function recordLatency(latencies, key, ms) {
  if (!latencies.has(key)) latencies.set(key, [])
  const arr = latencies.get(key)
  arr.push(ms)
  if (arr.length > LATENCY_WINDOW) arr.shift()
}

export function getAvgLatency(latencies, key) {
  const arr = latencies.get(key)
  if (!arr || arr.length === 0) return Infinity
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

/**
 * Sort channels by avg latency (ascending). Circuit-open and cooldown channels go to end.
 * @param {Array} channels - original channel list
 * @param {object} ctx - {latencies, circuitStates, cooldowns, cooldownMs}
 * @returns {Array} sorted channels
 */
export function getSortedChannels(channels, ctx) {
  const latencies = ctx.latencies instanceof Map ? ctx.latencies : new Map()
  const circuitStates = ctx.circuitStates instanceof Map ? ctx.circuitStates : new Map()
  const cooldowns = ctx.cooldowns instanceof Map ? ctx.cooldowns : new Map()
  const now = Date.now()

  const scored = channels.map(ch => {
    const key = channelKey(ch)
    const circuit = getCircuitState(circuitStates, key)
    const cooldownUntil = cooldowns.get(key) || 0
    const isCooling = now < cooldownUntil
    const isOpen = circuit.state === 'open' && now < circuit.openUntil
    const avg = getAvgLatency(latencies, key)

    // Priority: normal < cooling < circuit-open
    let bucket = 0
    if (isCooling) bucket = 1
    if (isOpen) bucket = 2

    return { channel: ch, key, bucket, avg }
  })

  scored.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket
    return a.avg - b.avg
  })

  return scored.map(s => s.channel)
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/channels.js
git commit -m "feat(channels): add latency tracking and sorting (#127)"
```

---

### Task 4: Integrate Latency Tracking into runChannels and index.js

**Files:**
- Modify: `lib/channels.js` — `runChannels()` to record latency
- Modify: `lib/index.js` — pass `latencies` Map, add `channelOrderMode` config, sort channels in auto-latency mode

**Interfaces:**
- Consumes: `recordLatency`, `getSortedChannels` from Task 3
- Produces: `channelOrderMode` config field — used by Task 7 (UI)

- [ ] **Step 1: Record latency in runChannels after runChannel**

In `runChannels()`, after `runChannel()` returns:

```js
    const t0 = Date.now()
    const attempt = await runChannel(channel, { /* ... */ })
    const elapsed = Date.now() - t0
    recordLatency(ctx.latencies || new Map(), key, elapsed)
    // ... rest of existing logic
```

- [ ] **Step 2: Add channelOrderMode to Config in index.js**

In the `Config` definition, after `channelFallback`:

```js
  channelOrderMode: z
    .union([z.const('manual'), z.const('auto-latency')])
    .description('How channels are ordered. manual = user-defined order (default). auto-latency = sort by average latency, fastest first.')
    .default('manual'),
```

- [ ] **Step 3: Add latencies Map in apply()**

In `index.js`, in `apply()`, after `channelCooldowns`:

```js
  const channelLatencies = new Map()
  const channelCircuitStates = new Map()
```

- [ ] **Step 4: Sort channels before runChannels in auto-latency mode**

In `callVisionModelWithBytes()`, before calling `runChannels()`:

```js
      let orderedChannels = config.channels
      if (config.channelOrderMode === 'auto-latency') {
        const { getSortedChannels } = await import('./channels.js')
        orderedChannels = getSortedChannels(config.channels, {
          latencies: channelLatencies,
          circuitStates: channelCircuitStates,
          cooldowns: channelCooldowns,
          cooldownMs: config.channelCooldownMs,
        })
      }
      const result = await runChannels(orderedChannels, {
        // ... existing params
        latencies: channelLatencies,
        circuitStates: channelCircuitStates,
      })
```

- [ ] **Step 5: Commit**

```bash
git add lib/channels.js lib/index.js
git commit -m "feat(channels): integrate latency tracking and auto-latency ordering (#127)"
```

---

### Task 5: Image Compression in index.js

**Files:**
- Modify: `lib/index.js` — add compression config, `compressImage()` helper, integrate into `callVisionModelWithBytes()`

**Interfaces:**
- Produces: `compressImage(bytes, opts)` — used in `callVisionModelWithBytes()` before sending
- Produces: `imageMaxWidth`, `imageMaxHeight`, `imageQuality`, `imageFormat` config fields — used by Task 7 (UI)

- [ ] **Step 1: Add compression config fields**

In `Config`, after `maxImageBytes`:

```js
  imageMaxWidth: z
    .number()
    .description('Maximum image width in pixels. Images larger than this are resized before sending to the vision model.')
    .default(1920),
  imageMaxHeight: z
    .number()
    .description('Maximum image height in pixels. Images larger than this are resized before sending to the vision model.')
    .default(1080),
  imageQuality: z
    .number()
    .description('Image compression quality (1-100) for WebP/JPEG output.')
    .default(80),
  imageFormat: z
    .union([z.const('auto'), z.const('webp'), z.const('jpeg')])
    .description('Output format for compressed images. auto = WebP if sharp available, else JPEG.')
    .default('auto'),
```

- [ ] **Step 2: Add compressImage helper**

In `index.js`, after `sniffMediaType()`:

```js
/**
 * Resize and compress an image for token savings.
 * Returns {bytes, contentType} — original if no compression needed or sharp unavailable.
 */
export async function compressImage(bytes, contentType, opts) {
  let sharp = null
  try { sharp = (await import('sharp')).default } catch { return { bytes, contentType } }
  if (!sharp) return { bytes, contentType }

  const { maxWidth = 1920, maxHeight = 1080, quality = 80, format = 'auto' } = opts || {}

  try {
    const img = sharp(bytes)
    const meta = await img.metadata()
    const needsResize = (meta.width && meta.width > maxWidth) || (meta.height && meta.height > maxHeight)

    let pipeline = img
    if (needsResize) {
      pipeline = pipeline.resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
    }

    let outFormat = format
    if (outFormat === 'auto') outFormat = 'webp'

    let outBytes, outType
    if (outFormat === 'webp') {
      outBytes = await pipeline.webp({ quality }).toBuffer()
      outType = 'image/webp'
    } else {
      outBytes = await pipeline.jpeg({ quality }).toBuffer()
      outType = 'image/jpeg'
    }

    // Only use compressed version if it's actually smaller
    if (outBytes.length < bytes.length) {
      return { bytes: outBytes, contentType: outType }
    }
    return { bytes, contentType }
  } catch {
    return { bytes, contentType }
  }
}
```

- [ ] **Step 3: Integrate compression into callVisionModelWithBytes**

In `callVisionModelWithBytes()`, before the channels-driven path:

```js
  const callVisionModelWithBytes = async (bytes, contentType, question, opts) => {
    // Compress image before sending
    const compressed = await compressImage(bytes, contentType, {
      maxWidth: config.imageMaxWidth,
      maxHeight: config.imageMaxHeight,
      quality: config.imageQuality,
      format: config.imageFormat,
    })
    bytes = compressed.bytes
    contentType = compressed.contentType

    // ... rest of existing logic
```

- [ ] **Step 4: Commit**

```bash
git add lib/index.js
git commit -m "feat(index): add image compression with sharp (#128)"
```

---

### Task 6: Extend API Routes

**Files:**
- Modify: `lib/index.js` — extend `/stats`, `/channels` GET, add `/circuit` route

**Interfaces:**
- Consumes: `channelCircuitStates`, `channelLatencies` from Task 4
- Produces: `/dsh-vision-bridge/circuit` endpoint — used by Task 7 (UI)

- [ ] **Step 1: Extend /stats with circuit and latency data**

In the `/stats` handler, add circuit state and latency info:

```js
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/stats',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
          const out = {}
          for (const [k, v] of usageByChannel) {
            const latencies = channelLatencies.get(k) || []
            const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0
            const circuit = channelCircuitStates.get(k) || { state: 'closed', failures: 0 }
            out[k] = {
              calls: v.calls,
              avgMs,
              lastMs: v.lastMs,
              errors: v.errors,
              latencies: latencies.slice(-10),
              circuitState: circuit.state,
              circuitFailures: circuit.failures,
            }
          }
          writeJson(200, { channels: out })
        },
      }),
    'dsh-vision-bridge: /stats route',
  )
```

- [ ] **Step 2: Extend /channels GET with circuit and latency**

In the `/channels` GET handler, add circuit and latency info to probe:

```js
  // In /channels GET handler
  const probe = list.map((c) => {
    const key = channelKey(c)
    const circuit = channelCircuitStates.get(key) || { state: 'closed', failures: 0 }
    const latencies = channelLatencies.get(key) || []
    const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0
    return {
      type: c && c.type,
      key: resolveKey(c),
      hasKey: hasUsableKey(c),
      circuitState: circuit.state,
      circuitFailures: circuit.failures,
      avgMs,
    }
  })
```

- [ ] **Step 3: Add /circuit endpoint**

```js
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-vision-bridge/circuit',
        handler: async (req, res) => {
          const writeJson = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
          if (req.method !== 'GET') { writeJson(405, { error: 'method not allowed' }); return }
          const out = {}
          for (const [k, v] of channelCircuitStates) {
            out[k] = { state: v.state, failures: v.failures, openUntil: v.openUntil }
          }
          writeJson(200, { circuits: out })
        },
      }),
    'dsh-vision-bridge: /circuit route',
  )
```

- [ ] **Step 4: Commit**

```bash
git add lib/index.js
git commit -m "feat(api): extend stats/channels with circuit+latency, add /circuit endpoint (#129 #127)"
```

---

### Task 7: UI — Settings Card Updates

**Files:**
- Modify: `lib/client.js` — add new settings fields to the Vision card

**Interfaces:**
- Consumes: `channelOrderMode`, `imageMaxWidth`, `imageMaxHeight`, `imageQuality`, `imageFormat` config from Task 4/5
- Consumes: `/dsh-vision-bridge/circuit` endpoint from Task 6

- [ ] **Step 1: Add channelOrderMode select**

In the settings card, after the existing channel-related fields, add:

```jsx
// Channel order mode
<div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' }}>
  <label style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
    {t('channelOrderMode') || 'Порядок каналов'}
  </label>
  <select
    value={config.channelOrderMode || 'manual'}
    onChange={e => updateConfig('channelOrderMode', e.target.value)}
    style={{ height: 34, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', borderRadius: 8, padding: '0 12px', fontSize: 13 }}
  >
    <option value="manual">{t('channelOrderManual') || 'Ручной'}</option>
    <option value="auto-latency">{t('channelOrderAutoLatency') || 'По латентности'}</option>
  </select>
</div>
```

- [ ] **Step 2: Add image compression fields**

```jsx
// Image compression
<div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' }}>
  <label style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
    {t('imageMaxWidth') || 'Макс. ширина (px)'}
  </label>
  <input
    type="number"
    value={config.imageMaxWidth || 1920}
    onChange={e => updateConfig('imageMaxWidth', Number(e.target.value))}
    style={{ height: 34, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', borderRadius: 8, padding: '0 12px', fontSize: 13 }}
  />
</div>
<div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' }}>
  <label style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
    {t('imageMaxHeight') || 'Макс. высота (px)'}
  </label>
  <input
    type="number"
    value={config.imageMaxHeight || 1080}
    onChange={e => updateConfig('imageMaxHeight', Number(e.target.value))}
    style={{ height: 34, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', borderRadius: 8, padding: '0 12px', fontSize: 13 }}
  />
</div>
<div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' }}>
  <label style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
    {t('imageQuality') || 'Качество (1-100)'}
  </label>
  <input
    type="number"
    min="1"
    max="100"
    value={config.imageQuality || 80}
    onChange={e => updateConfig('imageQuality', Number(e.target.value))}
    style={{ height: 34, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', borderRadius: 8, padding: '0 12px', fontSize: 13 }}
  />
</div>
```

- [ ] **Step 3: Add circuit breaker indicator per channel**

In the channel list, add a colored dot showing circuit state:

```jsx
// In channel list item
const circuitColor = ch.circuitState === 'closed' ? '#4caf50' : ch.circuitState === 'half-open' ? '#ff9800' : '#f44336'
// ... render dot
<span style={{ width: 8, height: 8, borderRadius: '50%', background: circuitColor, display: 'inline-block', marginRight: 8 }} />
```

- [ ] **Step 4: Add locale strings**

In the locale dictionaries (en/ru), add:

```js
// en
channelOrderMode: 'Channel order',
channelOrderManual: 'Manual',
channelOrderAutoLatency: 'By latency',
imageMaxWidth: 'Max width (px)',
imageMaxHeight: 'Max height (px)',
imageQuality: 'Quality (1-100)',

// ru
channelOrderMode: 'Порядок каналов',
channelOrderManual: 'Ручной',
channelOrderAutoLatency: 'По латентности',
imageMaxWidth: 'Макс. ширина (px)',
imageMaxHeight: 'Макс. высота (px)',
imageQuality: 'Качество (1-100)',
```

- [ ] **Step 5: Commit**

```bash
git add lib/client.js
git commit -m "feat(ui): add channel order, compression, and circuit breaker settings (#126 #127 #128 #129)"
```

---

### Task 8: OAuth Provider Integration (dsh-subscription)

**Files:**
- Modify: `lib/index.js` — detect dsh-subscription, inject OAuth channels

**Interfaces:**
- Consumes: `ctx.get('subscription')` or equivalent from dsh-subscription plugin
- Produces: OAuth channels appended to `config.channels` — used by runChannels

- [ ] **Step 1: Add includeOAuthProviders config**

In `Config`:

```js
  includeOAuthProviders: z
    .boolean()
    .description('If true and dsh-subscription plugin is installed, include OAuth vision providers as additional channels.')
    .default(true),
```

- [ ] **Step 2: Add OAuth provider detection in apply()**

In `apply()`, after the ollama probe:

```js
  // Detect dsh-subscription OAuth providers
  if (config.includeOAuthProviders !== false) {
    try {
      const subscription = ctx.get?.('subscription')
      if (subscription && typeof subscription.listProviders === 'function') {
        const oauthProviders = await subscription.listProviders()
        if (Array.isArray(oauthProviders)) {
          for (const p of oauthProviders) {
            if (p && p.baseURL && p.token) {
              const existing = config.channels.find(c =>
                c.type === 'openai-compatible' && c.baseURL === p.baseURL
              )
              if (!existing) {
                config.channels.push({
                  type: 'openai-compatible',
                  baseURL: p.baseURL,
                  apiKey: p.token,
                  model: p.model || '',
                })
              }
            }
          }
        }
      }
    } catch {}
  }
```

- [ ] **Step 3: Commit**

```bash
git add lib/index.js
git commit -m "feat(index): integrate OAuth providers from dsh-subscription (#126)"
```

---

### Task 9: Tests

**Files:**
- Modify: `test/regression.test.js` — add tests for circuit breaker, latency, compression

- [ ] **Step 1: Test circuit breaker state transitions**

```js
// Circuit breaker tests
import { getCircuitState, circuitSuccess, circuitFailure, isCircuitOpen } from '../lib/channels.js'

test('circuit breaker: closed → open after 3 failures', () => {
  const states = new Map()
  const key = 'test-channel'

  circuitFailure(states, key)
  assert.equal(isCircuitOpen(states, key), false)
  circuitFailure(states, key)
  assert.equal(isCircuitOpen(states, key), false)
  circuitFailure(states, key)
  assert.equal(isCircuitOpen(states, key), true)

  const s = getCircuitState(states, key)
  assert.equal(s.state, 'open')
  assert.equal(s.failures, 3)
})

test('circuit breaker: open → half-open after timeout', () => {
  const states = new Map()
  const key = 'test-channel'

  // Force open state with past timeout
  states.set(key, { failures: 3, state: 'open', openUntil: Date.now() - 1000 })
  assert.equal(isCircuitOpen(states, key), false) // transitions to half-open

  const s = getCircuitState(states, key)
  assert.equal(s.state, 'half-open')
})

test('circuit breaker: half-open → closed on success', () => {
  const states = new Map()
  const key = 'test-channel'

  states.set(key, { failures: 3, state: 'half-open', openUntil: 0 })
  circuitSuccess(states, key)

  const s = getCircuitState(states, key)
  assert.equal(s.state, 'closed')
  assert.equal(s.failures, 0)
})

test('circuit breaker: half-open → open on failure', () => {
  const states = new Map()
  const key = 'test-channel'

  states.set(key, { failures: 3, state: 'half-open', openUntil: 0 })
  circuitFailure(states, key)

  const s = getCircuitState(states, key)
  assert.equal(s.state, 'open')
  assert.equal(s.failures, 4)
})
```

- [ ] **Step 2: Test latency tracking**

```js
import { recordLatency, getAvgLatency, getSortedChannels } from '../lib/channels.js'

test('latency: rolling average', () => {
  const latencies = new Map()
  const key = 'test-channel'

  recordLatency(latencies, key, 100)
  recordLatency(latencies, key, 200)
  recordLatency(latencies, key, 300)

  assert.equal(getAvgLatency(latencies, key), 200)
})

test('latency: window limit', () => {
  const latencies = new Map()
  const key = 'test-channel'

  for (let i = 0; i < 15; i++) recordLatency(latencies, key, i * 100)
  assert.equal(latencies.get(key).length, 10) // only last 10 kept
})

test('latency: sort channels by avg latency', () => {
  const latencies = new Map()
  const circuitStates = new Map()
  const cooldowns = new Map()

  latencies.set('fast', [100, 100, 100])
  latencies.set('slow', [500, 500, 500])
  latencies.set('medium', [300, 300, 300])

  const channels = [
    { type: 'openai-compatible', baseURL: 'http://slow', model: 'm' },
    { type: 'openai-compatible', baseURL: 'http://fast', model: 'm' },
    { type: 'openai-compatible', baseURL: 'http://medium', model: 'm' },
  ]

  const sorted = getSortedChannels(channels, { latencies, circuitStates, cooldowns, cooldownMs: 0 })
  // fast should be first
  assert.ok(sorted[0].baseURL.includes('fast'))
})
```

- [ ] **Step 3: Test image compression**

```js
import { compressImage } from '../lib/index.js'

test('compression: returns original if sharp unavailable', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // PNG header
  const result = await compressImage(bytes, 'image/png', { maxWidth: 100, maxHeight: 100, quality: 80, format: 'webp' })
  // Should return original (sharp may or may not be available)
  assert.ok(result.bytes.length > 0)
  assert.ok(['image/png', 'image/webp', 'image/jpeg'].includes(result.contentType))
})
```

- [ ] **Step 4: Run tests**

```bash
cd /mnt/external/Project/DEV/dhsplugins/dsh-vision-bridge
node --test test/regression.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add test/regression.test.js
git commit -m "test: add circuit breaker, latency, and compression tests (#126 #127 #128 #129)"
```

---

### Task 10: Final Integration and Smoke Test

**Files:**
- No new files — verify everything works together

- [ ] **Step 1: Run full test suite**

```bash
cd /mnt/external/Project/DEV/dhsplugins/dsh-vision-bridge
node --test test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 2: Verify config schema is valid**

Check that all new config fields have defaults and don't break existing configs.

- [ ] **Step 3: Verify API endpoints respond**

On the server, test the new/extended endpoints:

```bash
curl -s http://localhost:3080/dsh-vision-bridge/stats | python3 -c "import sys,json; d=json.load(sys.stdin); print('stats OK:', len(d.get('channels',{})), 'channels')"
curl -s http://localhost:3080/dsh-vision-bridge/circuit | python3 -c "import sys,json; d=json.load(sys.stdin); print('circuit OK:', len(d.get('circuits',{})), 'circuits')"
curl -s http://localhost:3080/dsh-vision-bridge/channels | python3 -c "import sys,json; d=json.load(sys.stdin); print('channels OK:', len(d.get('channels',[])), 'channels')"
```

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "feat: Group 1 complete — circuit breaker, latency routing, image compression (#126 #127 #128 #129)"
```
