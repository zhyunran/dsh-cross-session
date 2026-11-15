/**
 * Deployment policy for the cross-session bridge.
 *
 * DSH passes the plugin's `config` block straight to `apply()`. This module
 * validates it once per load and freezes the effective policy, so a typo cannot
 * silently turn a restricted deployment into an open one.
 *
 * @module dsh-cross-session/config
 */

import path from 'node:path'
import { CrossSessionError } from './errors.js'

/** Effective defaults for a plain `install and use it` deployment. */
export const DEFAULT_CONFIG = Object.freeze({
  /** `all` | `workspace` | `allowlist` — who may address whom. */
  access: 'all',
  /** Session ids, exact titles, or `cwd:<path>` entries used by `allowlist`. */
  allowlist: [],
  /** Same vocabulary as allowlist; these are never listed, read, or written. */
  denylist: [],
  /** Allow `cross_session_send`. */
  allowSend: true,
  /** Allow `cross_session_list` / `_read` / `_search` / `_wait` to inspect peers. */
  allowRead: true,
  /** Allow `cross_session_create` to create a new blank top-level Session. */
  allowCreate: false,
  /** Absolute directories in which session creation is allowed; empty means any existing directory. */
  createRoots: [],
  /** Maximum successful creations in any rolling 60-second window. */
  maxCreatePerMinute: 5,
  /** Attach a protocol header naming the sender and the reply tool. */
  includeHeader: true,
  /** `agent-message` (honest peer attribution) or `user` (looks human). */
  messageSource: 'agent-message',
  /** Largest single attachment this bridge will copy into the attachment store. */
  maxFileBytes: 25 * 1024 * 1024,
  /** Most files accepted in one message. */
  maxFiles: 8,
  /** Largest message text accepted in one send. */
  maxMessageChars: 100_000,
  /** Characters returned by one read/wait result. */
  maxTranscriptChars: 60_000,
  /** Events scanned by one read/search before reporting truncation. */
  maxEvents: 20_000,
  /** Default number of transcript entries returned by `_read`. */
  defaultReadLimit: 20,
  /** Default number of hits returned by `_search`. */
  defaultSearchLimit: 10,
  /** Default seconds `_wait` and `send({wait:true})` wait for idleness. */
  defaultWaitSeconds: 120,
  /** Hard ceiling for any wait. */
  maxWaitSeconds: 600,
})

const ACCESS_MODES = new Set(['all', 'workspace', 'allowlist'])
const MESSAGE_SOURCES = new Set(['agent-message', 'user'])

function readNumber (source, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  const raw = source[key]
  if (raw === undefined) return fallback
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new CrossSessionError('CONFIG_INVALID', `dsh-cross-session config.${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`)
  }
  return value
}

function readBoolean (source, key, fallback) {
  const raw = source[key]
  if (raw === undefined) return fallback
  if (typeof raw !== 'boolean') {
    throw new CrossSessionError('CONFIG_INVALID', `dsh-cross-session config.${key} must be true or false.`)
  }
  return raw
}

function readStringList (source, key) {
  const raw = source[key]
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new CrossSessionError('CONFIG_INVALID', `dsh-cross-session config.${key} must be an array of non-empty strings.`)
  }
  return raw.map((entry) => entry.trim())
}

/**
 * Validate one raw config block and return the effective frozen policy.
 *
 * @param {unknown} raw plugin config supplied by cordis.
 * @returns {Readonly<typeof DEFAULT_CONFIG>}
 */
export function normalizeConfig (raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  const access = source.access === undefined ? DEFAULT_CONFIG.access : String(source.access).trim()
  if (!ACCESS_MODES.has(access)) {
    throw new CrossSessionError('CONFIG_INVALID', 'dsh-cross-session config.access must be one of: all, workspace, allowlist.')
  }

  const messageSource = source.messageSource === undefined ? DEFAULT_CONFIG.messageSource : String(source.messageSource).trim()
  if (!MESSAGE_SOURCES.has(messageSource)) {
    throw new CrossSessionError('CONFIG_INVALID', 'dsh-cross-session config.messageSource must be "agent-message" or "user".')
  }

  const effective = {
    access,
    allowlist: readStringList(source, 'allowlist'),
    denylist: readStringList(source, 'denylist'),
    allowSend: readBoolean(source, 'allowSend', DEFAULT_CONFIG.allowSend),
    allowRead: readBoolean(source, 'allowRead', DEFAULT_CONFIG.allowRead),
    allowCreate: readBoolean(source, 'allowCreate', DEFAULT_CONFIG.allowCreate),
    createRoots: readStringList(source, 'createRoots'),
    maxCreatePerMinute: readNumber(source, 'maxCreatePerMinute', DEFAULT_CONFIG.maxCreatePerMinute, { min: 1, max: 60, integer: true }),
    includeHeader: readBoolean(source, 'includeHeader', DEFAULT_CONFIG.includeHeader),
    messageSource,
    maxFileBytes: readNumber(source, 'maxFileBytes', DEFAULT_CONFIG.maxFileBytes, { min: 1, max: 1024 * 1024 * 1024, integer: true }),
    maxFiles: readNumber(source, 'maxFiles', DEFAULT_CONFIG.maxFiles, { min: 1, max: 64, integer: true }),
    maxMessageChars: readNumber(source, 'maxMessageChars', DEFAULT_CONFIG.maxMessageChars, { min: 1, max: 10_000_000, integer: true }),
    maxTranscriptChars: readNumber(source, 'maxTranscriptChars', DEFAULT_CONFIG.maxTranscriptChars, { min: 1000, max: 1_000_000, integer: true }),
    maxEvents: readNumber(source, 'maxEvents', DEFAULT_CONFIG.maxEvents, { min: 100, max: 1_000_000, integer: true }),
    defaultReadLimit: readNumber(source, 'defaultReadLimit', DEFAULT_CONFIG.defaultReadLimit, { min: 1, max: 500, integer: true }),
    defaultSearchLimit: readNumber(source, 'defaultSearchLimit', DEFAULT_CONFIG.defaultSearchLimit, { min: 1, max: 200, integer: true }),
    defaultWaitSeconds: readNumber(source, 'defaultWaitSeconds', DEFAULT_CONFIG.defaultWaitSeconds, { min: 1, max: DEFAULT_CONFIG.maxWaitSeconds, integer: true }),
    maxWaitSeconds: readNumber(source, 'maxWaitSeconds', DEFAULT_CONFIG.maxWaitSeconds, { min: 1, max: 3600, integer: true }),
  }

  if (effective.defaultWaitSeconds > effective.maxWaitSeconds) {
    throw new CrossSessionError('CONFIG_INVALID', 'dsh-cross-session config.defaultWaitSeconds must not exceed config.maxWaitSeconds.')
  }
  for (const root of effective.createRoots) {
    if (!path.isAbsolute(root)) {
      throw new CrossSessionError('CONFIG_INVALID', `dsh-cross-session config.createRoots entry "${root}" must be an absolute path.`)
    }
  }

  return Object.freeze(effective)
}
