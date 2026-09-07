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

/**
 * Checks if a binary is installed and executable on the host.
 */
export async function isBinaryAvailable(bin, checkArg = '--version') {
  try {
    const res = await runProcessAsync(bin, [checkArg], { timeout: 3000 })
    return res.code === 0 && !res.error
  } catch {
    return false
  }
}
