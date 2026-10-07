import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { wrapConfig } from './vision-core.js'

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
  if (config.evidenceDir && typeof config.evidenceDir === 'string' && config.evidenceDir.trim()) {
    return resolve(config.evidenceDir.trim())
  }
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
  if (ctxDataDir && typeof ctxDataDir === 'string' && ctxDataDir.trim()) {
    return resolve(ctxDataDir.trim())
  }
  if (ctxBaseDir && typeof ctxBaseDir === 'string' && ctxBaseDir.trim()) {
    return resolve(ctxBaseDir.trim(), 'data')
  }
  if (process.env.DSH_DATA_DIR && process.env.DSH_DATA_DIR.trim()) {
    return resolve(process.env.DSH_DATA_DIR.trim())
  }
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) {
    return resolve(process.env.DSH_HOME.trim(), 'data')
  }
  const defaultDsh = join(homedir(), '.dsh')
  if (existsSync(defaultDsh)) {
    return defaultDsh
  }
  return process.cwd()
}
