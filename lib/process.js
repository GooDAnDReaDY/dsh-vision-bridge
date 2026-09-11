// dsh-vision-bridge — non-blocking async process runner.
//
// Spawns external binaries (pdftoppm, tesseract, ffmpeg, chrome) asynchronously
// without blocking the Node.js event loop.

import { execFile } from 'node:child_process'

/**
 * Executes a binary asynchronously with args, timeout, and signal support.
 * Returns { stdout, stderr, code, error }.
 */
export function runProcessAsync(bin, args = [], { timeout = 30000, signal, maxBuffer = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile(bin, args, { timeout, signal, maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          code: child.exitCode ?? (error ? 1 : 0),
          error: error || null,
        })
      })
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err?.message || String(err),
        code: 1,
        error: err,
      })
    }
  })
}

/** Version flags to try, in order. poppler rejects `--version` but accepts `-v`,
 *  ffmpeg only accepts `-version`, tesseract takes `--version`. */
const VERSION_FLAGS = ['--version', '-version', '-v']

/**
 * Checks if a binary is installed and executable on the host. Tries every known
 * version flag, because a single hardcoded one silently reports poppler and
 * ffmpeg as missing — which is how the pdftotext text layer stayed disabled.
 */
export async function isBinaryAvailable(bin, checkArg) {
  const flags = checkArg ? [checkArg, ...VERSION_FLAGS.filter((f) => f !== checkArg)] : VERSION_FLAGS
  for (const flag of flags) {
    try {
      const res = await runProcessAsync(bin, [flag], { timeout: 3000 })
      if (res.code === 0 && !res.error) return true
    } catch {}
  }
  return false
}
