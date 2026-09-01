# Design: Group 1 — Routing & Fallback

**Date:** 2026-08-30
**Plugin:** dsh-vision-bridge
**Issues:** #126, #127, #128, #129

## Summary

Add circuit breaker, latency-based channel ordering, image compression, and OAuth provider integration to the vision bridge routing layer.

## Decisions

| Issue | Decision |
|-------|----------|
| #129 Circuit Breaker | 3 consecutive failures → block 5 min → half-open → probe → close/block |
| #126 Fallback Chain | Flat ordered list, no tiers. Integration with dsh-subscription for OAuth |
| #127 Latency Switching | Two modes: manual / auto-latency (reorder by rolling avg) |
| #125 Cost Routing | Not needed — deferred |
| #128 Token Budget | Resize + WebP/JPEG compression, settings: maxWidth/maxHeight/quality |

## Architecture

Approach: extend existing `channels.js` and `index.js` (no new files).

### 1. Circuit Breaker (#129)

**State per channel** in extended Map:

```js
channelState: Map<key, {
  failures: number,        // consecutive error count
  state: 'closed'|'open'|'half-open',
  openUntil: number,       // timestamp when open → half-open
}>
```

**Logic:**
- `closed` → normal. Success → `failures=0`. Error → `failures++`.
- `failures >= 3` → `state='open'`, `openUntil=Date.now()+300000` (5 min)
- `Date.now() > openUntil` → `state='half-open'`, allow one request
- half-open + success → `state='closed'`, `failures=0`
- half-open + error → `state='open'`, `openUntil=Date.now()+300000`

**Where checked:** in `runChannels()`, before `runChannel()`. If `state='open'` and time not elapsed — skip with `circuit-open` marker.

### 2. Latency-based Switching (#127)

**New config:**
```js
channelOrderMode: z.union([z.const('manual'), z.const('auto-latency')]).default('manual')
```

**Tracking:** extend `usageByChannel` — add `latencies[]` (last 10 calls), `avgMs` computed on the fly.

**Logic in auto-latency:**
- Before `runChannels()` sort channels by `avgMs` (ascending)
- Circuit-open channels → end
- Cooldown channels → after circuit-open

### 3. Fallback Chain (#126)

**Integration with dsh-subscription:**
- In `apply()` check `ctx.get('subscription')` (or equivalent)
- If plugin installed → request OAuth provider list
- Convert to `openai-compatible` channels with OAuth token
- Append to channel list (user can reorder)

**New config:**
```js
includeOAuthProviders: z.boolean().default(true)
```

### 4. Image Compression (#128)

**New config:**
```js
imageMaxWidth: z.number().default(1920),
imageMaxHeight: z.number().default(1080),
imageQuality: z.number().default(80),  // 1-100, for WebP/JPEG
imageFormat: z.union([z.const('auto'), z.const('webp'), z.const('jpeg')]).default('auto'),
```

**Where applied:** in `callVisionModelWithBytes()`, before `runChannels()` or `ctx.llm.stream()`.

**Logic:**
1. Check dimensions (width/height) — if exceeds limit, resize
2. Convert to WebP (if sharp available) or JPEG
3. If sharp not available → skip compression (fallback to current behavior)

**sharp detection:**
```js
let sharp = null
try { sharp = (await import('sharp')).default } catch {}
```

### 5. Config Changes

Add to `Config`:
```js
channelOrderMode: z.union([z.const('manual'), z.const('auto-latency')]).default('manual'),
includeOAuthProviders: z.boolean().default(true),
imageMaxWidth: z.number().default(1920),
imageMaxHeight: z.number().default(1080),
imageQuality: z.number().default(80),
imageFormat: z.union([z.const('auto'), z.const('webp'), z.const('jpeg')]).default('auto'),
```

### 6. API Changes

**Extend `/stats`:**
- Add `avgMs`, `latencies[]`, `circuitState` per channel

**Extend `/channels` GET:**
- Add `circuitState`, `avgMs` in probe

**New `/dsh-vision-bridge/circuit` GET:**
- Circuit breaker state per channel (for UI)

### 7. UI Changes (client.js)

**In settings card:**
- New select: "Channel order" (manual / auto-latency)
- New checkbox: "Use OAuth providers"
- New fields: maxWidth, maxHeight, quality, format
- Circuit breaker indicator per channel (color dot)

## Files Modified

- `lib/channels.js` — circuit breaker state, latency tracking, channel sorting
- `lib/index.js` — new config fields, image compression, OAuth integration, new/extended API routes
- `lib/client.js` — new UI fields in settings card

## Testing

- Unit: circuit breaker state transitions (closed→open→half-open→closed)
- Unit: latency tracking (rolling average)
- Unit: image compression (resize + format conversion)
- Integration: channel ordering in auto-latency mode
- Integration: OAuth provider injection from dsh-subscription
