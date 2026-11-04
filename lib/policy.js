/**
 * Who may see and address whom.
 *
 * Two independent questions:
 *   1. Is this a top-level, ordinary DSH session? (subagent branches are not
 *      addressable peers and cannot be resumed through the Session controller.)
 *   2. Does the deployment policy allow this caller to reach this target?
 *
 * @module dsh-cross-session/policy
 */

import { CrossSessionError } from './errors.js'
import { samePath } from './util.js'

/** True when a Session header belongs to a subagent / delegated branch. */
export function isSubagentHeader (header) {
  if (header === null || header === undefined) return false
  return header.parentSession !== undefined && header.parentSession !== null
}

/** True when a normalized session row belongs to a subagent branch. */
export function isSubagentItem (item) {
  if (item === null || item === undefined) return false
  return item.parentSessionId !== undefined || item.origin === 'subagent'
}

/**
 * Extract the caller identity from one tool execution.
 *
 * @param {{ agent?: unknown }} exec tool execution context supplied by DSH.
 * @returns {{ id: string, cwd?: string, isSubagent: boolean, agent: any }}
 */
export function callerFromExec (exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null || typeof agent.id !== 'string') {
    throw new CrossSessionError('NO_CALLER_SESSION', 'cross_session_* tools can only be called from inside a DSH agent session.')
  }
  const header = agent.session?.header ?? {}
  return {
    id: agent.id,
    cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
    isSubagent: isSubagentHeader(header) || header.origin === 'subagent',
    agent,
  }
}

/** Refuse delegated branches: their lifecycle belongs to their parent. */
export function assertOrdinaryCaller (caller) {
  if (caller.isSubagent) {
    throw new CrossSessionError(
      'SUBAGENT_CALLER',
      'cross-session tools are for top-level sessions. This session is a delegated child; report to the session that created it instead.',
    )
  }
}

/** All id spellings a user might type for one session. */
export function idVariants (id) {
  const text = String(id ?? '')
  const bare = text.startsWith('session-') ? text.slice('session-'.length) : text
  return text === bare ? [text] : [text, bare]
}

/** Match one policy-list entry (`*`, `cwd:<path>`, id, or exact title). */
export function matchesPolicyEntry (entry, target) {
  if (typeof entry !== 'string') return false
  const value = entry.trim()
  if (value.length === 0) return false
  if (value === '*') return true
  if (value.toLowerCase().startsWith('cwd:')) return samePath(value.slice(4).trim(), target.cwd)
  const needle = value.toLowerCase()
  if ((target.title ?? '').toLowerCase() === needle) return true
  return idVariants(target.id).some((candidate) => candidate.toLowerCase() === needle)
}

function matchesAny (entries, target) {
  return entries.some((entry) => matchesPolicyEntry(entry, target))
}

/**
 * Pure permission decision.
 *
 * @param {Readonly<Record<string, unknown>>} config effective plugin policy.
 * @param {{ id: string, cwd?: string }} caller
 * @param {{ id: string, title?: string, cwd?: string, origin?: string, parentSessionId?: string }} target
 * @param {'read' | 'send'} action
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isAllowed (config, caller, target, action) {
  if (action === 'send' && config.allowSend !== true) {
    return { ok: false, reason: 'this deployment disabled cross-session sends (config.allowSend = false)' }
  }
  if (action === 'read' && config.allowRead !== true) {
    return { ok: false, reason: 'this deployment disabled cross-session reads (config.allowRead = false)' }
  }
  if (target.id === caller.id) {
    return { ok: false, reason: 'a session cannot address itself' }
  }
  if (isSubagentItem(target)) {
    return { ok: false, reason: 'that session is a delegated subagent branch, not a top-level peer' }
  }
  if (matchesAny(config.denylist, target)) {
    return { ok: false, reason: 'that session is on the deployment denylist' }
  }
  switch (config.access) {
    case 'all':
      return { ok: true }
    case 'workspace':
      if (caller.cwd === undefined || target.cwd === undefined || !samePath(caller.cwd, target.cwd)) {
        return { ok: false, reason: 'that session belongs to a different workspace (config.access = "workspace")' }
      }
      return { ok: true }
    case 'allowlist':
      if (!matchesAny(config.allowlist, target)) {
        return { ok: false, reason: 'that session is not on the deployment allowlist' }
      }
      return { ok: true }
    default:
      return { ok: false, reason: `unknown access mode "${String(config.access)}"` }
  }
}

/** Throwing form of {@link isAllowed} with a model-facing next step. */
export function assertAllowed (config, caller, target, action) {
  const decision = isAllowed(config, caller, target, action)
  if (decision.ok) return
  const verb = action === 'send' ? 'message' : 'read'
  throw new CrossSessionError(
    'SESSION_NOT_ALLOWED',
    `not allowed to ${verb} session "${target.title || target.id}" (${target.id}): ${decision.reason}.`,
    { sessionId: target.id },
  )
}
