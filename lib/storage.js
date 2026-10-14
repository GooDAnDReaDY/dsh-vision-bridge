import { tmpdir, homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { wrapConfig, resolveInside } from './vision-core.js'

export const probeStorage = async () => {
  try {
    const probePath = join(tmpdir(), 'vbr-probe-' + Date.now() + '.tmp')
    writeFileSync(probePath, 'probe')
    const ok = readFileSync(probePath, 'utf8') === 'probe'
    unlinkSync(probePath)
    return { ok, error: ok ? undefined : 'read-back mismatch' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) }
  }
}

export function resolveStorageDir(ctx, rawConfig) {
  const config = wrapConfig(rawConfig)
  let ctxDataDir = null
  let ctxBaseDir = null
  try {
    ctxDataDir = (typeof ctx?.get === 'function' ? ctx.get('dataDir') : null) || ctx?.dataDir
  } catch (_err) {
    // optional cordis property probe
  }
  try {
    ctxBaseDir = (typeof ctx?.get === 'function' ? ctx.get('baseDir') : null) || ctx?.baseDir
  } catch (_err) {
    // optional cordis property probe
  }

  let baseDir
  if (ctxDataDir && typeof ctxDataDir === 'string' && ctxDataDir.trim()) {
    baseDir = resolve(ctxDataDir.trim())
  } else if (ctxBaseDir && typeof ctxBaseDir === 'string' && ctxBaseDir.trim()) {
    baseDir = resolve(ctxBaseDir.trim(), 'data')
  } else if (process.env.DSH_DATA_DIR && process.env.DSH_DATA_DIR.trim()) {
    baseDir = resolve(process.env.DSH_DATA_DIR.trim())
  } else if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) {
    baseDir = resolve(process.env.DSH_HOME.trim(), 'data')
  } else {
    const defaultDsh = join(homedir(), '.dsh')
    if (existsSync(defaultDsh)) {
      baseDir = defaultDsh
    } else {
      baseDir = process.cwd()
    }
  }

  // #435: Constrain relative evidenceDir to baseDir via resolveInside to prevent path traversal
  if (config.evidenceDir && typeof config.evidenceDir === 'string' && config.evidenceDir.trim()) {
    const candidate = config.evidenceDir.trim()
    if (!isAbsolute(candidate)) {
      return resolveInside(baseDir, candidate)
    }
    return resolve(candidate)
  }

  return baseDir
}
