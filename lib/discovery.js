/**
 * Session discovery, name resolution, and titles.
 *
 * A peer is any top-level session in this DSH profile, live or persisted. The
 * Session controller already knows how to enumerate both without activating an
 * Agent, so this module leans on that and keeps a persistence fallback for
 * compositions that mount a different API surface.
 *
 * @module dsh-cross-session/discovery
 */

import { CrossSessionError } from './errors.js'
import { idVariants, isSubagentItem } from './policy.js'

function titleFromProjections (projections) {
  const value = projections?.values?.title
  return typeof value === 'string' ? value : ''
}

function fromSummary (item) {
  return {
    id: String(item.sessionId),
    title: titleFromProjections(item.projections),
    cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    running: item.running === true,
    live: item.agentAvailable === true,
    blank: item.blank === true,
    origin: typeof item.origin === 'string' ? item.origin : undefined,
    parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : undefined,
  }
}

function fromHeader (header, extra = {}) {
  return {
    id: String(header?.id ?? ''),
    title: '',
    cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
    updatedAt: typeof header?.createdAt === 'number' ? header.createdAt : 0,
    running: false,
    live: false,
    blank: false,
    origin: typeof header?.origin === 'string' ? header.origin : undefined,
    parentSessionId: typeof header?.parentSession === 'string' ? header.parentSession : undefined,
    ...extra,
  }
}

function liveRow (session, ctx) {
  const agent = ctx.get('agents')?.get?.(session.id)
  return fromHeader(session.header, {
    // "live" means this Session object exists in the running process, which is
    // true even for a just-opened blank conversation with no Agent yet.
    live: true,
    running: agent?.status === 'running',
    blank: typeof session.seq === 'number' ? session.seq === 0 : false,
  })
}

async function fallbackList (ctx, signal) {
  const rows = []
  const seen = new Set()
  const sessions = ctx.get('sessions')
  if (sessions && typeof sessions.list === 'function') {
    for (const session of sessions.list()) {
      const row = liveRow(session, ctx)
      if (row.id.length === 0 || seen.has(row.id)) continue
      seen.add(row.id)
      rows.push(row)
    }
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence && typeof persistence.list === 'function') {
    let snapshots = []
    try {
      snapshots = await persistence.list()
    } catch {
      snapshots = []
    }
    signal?.throwIfAborted()
    for (const snapshot of snapshots) {
      const header = snapshot?.header
      if (!header || typeof header.id !== 'string' || seen.has(header.id)) continue
      seen.add(header.id)
      rows.push(fromHeader(header))
    }
  }
  return rows
}

/**
 * Fill blank titles from the Session query index when the list projection held
 * none (cold rows whose projection cache is absent).
 */
async function fillTitles (ctx, items, signal) {
  const missing = items.filter((item) => item.title.length === 0)
  if (missing.length === 0) return
  const query = ctx.get('sessionQuery')
  if (query && typeof query.readTitleSnapshots === 'function') {
    try {
      const results = await query.readTitleSnapshots(missing.map((item) => item.id), signal)
      const byId = new Map()
      for (const result of results ?? []) {
        if (result?.status !== 'fulfilled') continue
        const sessionId = result.value?.session?.id
        if (typeof sessionId === 'string') byId.set(sessionId, result.value)
      }
      for (const item of missing) {
        const value = byId.get(item.id)
        if (value !== undefined && typeof value.title === 'string') item.title = value.title
      }
    } catch {
      /* live fallback below */
    }
  }
  // A just-opened, not-yet-indexed Session can exist only in memory. Its title
  // event is already in the live log even when the query index has no row.
  const stillMissing = items.filter((item) => item.title.length === 0)
  if (stillMissing.length === 0) return
  const sessions = ctx.get('sessions')
  for (const item of stillMissing) {
    const live = sessions?.get?.(item.id)
    if (live === undefined || live === null || typeof live.snapshotEvents !== 'function') continue
    try {
      const events = live.snapshotEvents()
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim().length > 0) {
          item.title = event.data.title.trim()
          break
        }
      }
    } catch {
      /* leave untitled */
    }
  }
}

/**
 * Enumerate every visible session, live and persisted, without activating an
 * Agent. Ordered newest activity first.
 *
 * @param {any} ctx plugin context with `sessionController` / `sessions` / `sessionPersistence`.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Array<ReturnType<typeof fromSummary>>>}
 */
export async function listSessions (ctx, { signal } = {}) {
  const controller = ctx.get('sessionController')
  let items
  if (controller && typeof controller.list === 'function') {
    try {
      const result = await controller.list({}, signal)
      if (Array.isArray(result?.items)) items = result.items.map(fromSummary)
    } catch (error) {
      signal?.throwIfAborted()
      items = undefined
    }
  }
  if (!Array.isArray(items)) items = await fallbackList(ctx, signal)
  // The query-backed list is persistence-first. A Session opened moments ago
  // can be live in memory before it is indexed; merge those rows so a
  // just-created conversation is immediately addressable by title.
  const liveStore = ctx.get('sessions')
  if (Array.isArray(items) && liveStore) {
    const known = new Set(items.map((item) => item.id))
    // A row can be in the persistence-backed list while its Agent is not
    // available yet; the Session object itself proves it is live.
    if (typeof liveStore.get === 'function') {
      for (const item of items) {
        if (liveStore.get(item.id) !== undefined) item.live = true
      }
    }
    if (typeof liveStore.list === 'function') {
      for (const live of liveStore.list()) {
        if (typeof live?.id !== 'string' || known.has(live.id)) continue
        known.add(live.id)
        items.push(liveRow(live, ctx))
      }
    }
  }
  await fillTitles(ctx, items, signal)
  items = items.filter((item) => item.id.length > 0)
  items.sort((left, right) => right.updatedAt - left.updatedAt)
  return items
}

/** Read one session's current title, or `''` when it has none. */
export async function titleOf (ctx, sessionId, signal) {
  const query = ctx.get('sessionQuery')
  if (query && typeof query.readTitle === 'function') {
    try {
      const title = await query.readTitle(sessionId, signal)
      if (typeof title === 'string') return title
    } catch {
      /* fall through to the live log */
    }
  }
  const live = ctx.get('sessions')?.get?.(sessionId)
  if (live && typeof live.snapshotEvents === 'function') {
    try {
      const events = live.snapshotEvents()
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title
      }
    } catch {
      /* no title */
    }
  }
  return ''
}

function describeCandidate (item) {
  const state = item.running ? 'running' : item.live ? 'idle' : 'cold'
  return `"${item.title || '(untitled)'}" (${item.id}, ${state})`
}

/**
 * Resolve a model-supplied reference: exact id, exact title, then unique
 * id/title/cwd prefix or substring. Ambiguity is an error listing candidates;
 * silently picking one would send work to the wrong conversation.
 *
 * @param {any} ctx
 * @param {string} reference
 * @param {{ signal?: AbortSignal, includeSubagents?: boolean }} [options]
 * @returns {Promise<ReturnType<typeof fromSummary>>}
 */
export async function resolveSession (ctx, reference, { signal } = {}) {
  const ref = String(reference ?? '').trim()
  if (ref.length === 0) {
    throw new CrossSessionError('SESSION_REF_EMPTY', 'a session id or title is required. Run cross_session_list to see the available sessions.')
  }
  const items = await listSessions(ctx, { signal })
  const needle = ref.toLowerCase()
  const idHit = items.filter((item) => idVariants(item.id).some((candidate) => candidate.toLowerCase() === needle))
  let matches = idHit
  if (matches.length === 0) matches = items.filter((item) => (item.title ?? '').toLowerCase() === needle)
  if (matches.length === 0) {
    matches = items.filter((item) => (item.title ?? '').toLowerCase().startsWith(needle) || idVariants(item.id).some((candidate) => candidate.toLowerCase().startsWith(needle)))
  }
  if (matches.length === 0) {
    matches = items.filter((item) => (item.title ?? '').toLowerCase().includes(needle) || idVariants(item.id).some((candidate) => candidate.toLowerCase().includes(needle)))
  }
  if (matches.length === 0) {
    throw new CrossSessionError(
      'SESSION_NOT_FOUND',
      `no session matches "${ref}". Run cross_session_list to see the sessions in this DSH profile, then pass an exact id or title.`,
      { reference: ref },
    )
  }
  if (matches.length > 1) {
    const candidates = matches.slice(0, 8).map(describeCandidate).join('; ')
    throw new CrossSessionError(
      'SESSION_AMBIGUOUS',
      `"${ref}" matches ${matches.length} sessions: ${candidates}. Pass the exact session id (or a longer title).`,
      { reference: ref, candidates: matches.slice(0, 8).map((item) => item.id) },
    )
  }
  const target = matches[0]
  if (isSubagentItem(target)) {
    throw new CrossSessionError(
      'SUBAGENT_SESSION',
      `"${target.title || target.id}" is a delegated subagent branch, not a top-level peer. Address its parent session instead.`,
      { sessionId: target.id },
    )
  }
  return target
}
