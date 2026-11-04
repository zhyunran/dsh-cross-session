/**
 * Small, dependency-free helpers shared by the plugin modules.
 *
 * This file deliberately has no DSH imports so unit tests can load it with a
 * plain Node interpreter and no profile installed.
 *
 * @module dsh-cross-session/util
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'

/**
 * Cut text on a code-point boundary and report what was cut.
 *
 * @param {unknown} value source text.
 * @param {number} max maximum retained UTF-16 units.
 * @returns {{ text: string, truncated: boolean, originalLength: number }}
 */
export function truncate (value, max) {
  const text = String(value ?? '')
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) {
    return { text, truncated: false, originalLength: text.length }
  }
  const cut = Math.max(0, Math.floor(max) - 1)
  return { text: `${text.slice(0, cut)}…`, truncated: true, originalLength: text.length }
}

/** Render one epoch millisecond value as a stable UTC timestamp. */
export function isoTime (ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)}Z`
}

/** Recursively freeze a JSON-like value without cloning it. */
export function deepFreeze (value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

/**
 * Build the exact user-role message DSH's agent inbox expects.
 *
 * Mirrors `createUserMessage` from `@deepseek-ai/dsh-llm` (fresh stable id,
 * frozen snapshot) without taking a dependency on that package, so this plugin
 * loads against any 0.2.x host that provides `dsh-tools`.
 *
 * @param {{ content: Array<Record<string, unknown>>, source: Record<string, unknown> }} input
 * @returns {Readonly<Record<string, unknown>>}
 */
export function createUserMessage ({ content, source }) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content,
    source,
  })
}

/** Normalize a single-or-array argument into an array. */
export function asArray (value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** Case-insensitive path equality on Windows, exact elsewhere. */
export function samePath (left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length === 0 || right.length === 0) return false
  let a
  let b
  try {
    a = path.resolve(left)
    b = path.resolve(right)
  } catch {
    return false
  }
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Human-facing byte count. */
export function formatBytes (bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Wait for a wall-clock delay, observably cancellable. */
export function delay (ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    function onAbort () {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** True when a failure is just caller cancellation. */
export function isAbort (error, signal) {
  return signal?.aborted === true || (error && typeof error === 'object' && (error.name === 'AbortError' || error.code === 'ABORT_ERR'))
}
