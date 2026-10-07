let activeLogger = null

const fallbackLogger = {
  debug: (...args) => {
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug(...args)
    }
  },
  info: (...args) => {
    if (typeof console !== 'undefined' && typeof console.info === 'function') {
      console.info(...args)
    }
  },
  warn: (...args) => {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(...args)
    }
  },
  error: (...args) => {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(...args)
    }
  },
}

export function getLogger(ctx, scope = 'vision-bridge') {
  if (ctx && typeof ctx.logger === 'function') {
    try {
      return ctx.logger(scope)
    } catch (_err) {
      // logger factory failed; safe fallback
    }
  }
  if (ctx && ctx.logger && typeof ctx.logger.info === 'function') {
    return ctx.logger
  }
  return fallbackLogger
}

export function setPluginLogger(logger) {
  activeLogger = logger
}

export function getPluginLogger(ctx) {
  if (ctx) {
    const l = getLogger(ctx)
    if (l) return l
  }
  if (activeLogger) return activeLogger
  return fallbackLogger
}
