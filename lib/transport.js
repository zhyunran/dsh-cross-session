/**
 * Delivery into another live DSH session, and the read/wait primitives that
 * make the result verifiable.
 *
 * This is the same path the built-in Schedule feature uses:
 *   `ctx.sessionController.resolveAgent(id)` → `agent.followup(message)` →
 *   `ctx.sessions.flush(agent.session)`.
 *
 * `resolveAgent` resumes a cold persisted session with its own preset and model
 * selection, so the peer runs as a real top-level session — not as a subagent.
 *
 * @module dsh-cross-session/transport
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { CrossSessionError, describeError, remoteFailure } from './errors.js'
import { createUserMessage, delay, formatBytes, isAbort } from './util.js'

/**
 * Read one session's durable event log without activating an Agent.
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ header: Record<string, any> | undefined, events: Array<Record<string, any>> }>}
 */
export async function readSessionLog (ctx, sessionId, signal) {
  const controller = ctx.get('sessionController')
  let lastError
  if (controller && typeof controller.inspect === 'function') {
    try {
      const inspected = await controller.inspect(sessionId, signal)
      if (inspected && Array.isArray(inspected.events)) {
        return { header: inspected.meta, events: inspected.events }
      }
    } catch (error) {
      if (isAbort(error, signal)) throw error
      lastError = error
    }
  }

  const live = ctx.get('sessions')?.get?.(sessionId)
  if (live !== undefined && live !== null) {
    const events = typeof live.snapshotEvents === 'function' ? live.snapshotEvents() : []
    return { header: live.header, events: Array.isArray(events) ? events : [] }
  }

  const persistence = ctx.get('sessionPersistence')
  if (persistence && typeof persistence.open === 'function') {
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
      const read = await handle.read()
      return {
        header: handle.header,
        events: Array.isArray(read?.events) ? read.events : [],
      }
    } finally {
      try {
        await handle?.close?.()
      } catch {
        /* a close failure must not mask the read result */
      }
    }
  }

  if (lastError !== undefined) throw lastError
  throw new CrossSessionError(
    'SESSION_UNREADABLE',
    `session "${sessionId}" could not be read: this DSH build exposes neither Session.inspect nor a session persistence backend.`,
    { sessionId },
  )
}

/**
 * Get the live Agent for a session, resuming it through the Session controller
 * when it is cold. Returns `{ agent, resumed }`.
 */
export async function resolveAgent (ctx, sessionId) {
  const live = ctx.get('agents')?.get?.(sessionId)
  if (live !== undefined && live !== null) return { agent: live, resumed: false }

  const controller = ctx.get('sessionController')
  if (!controller || typeof controller.resolveAgent !== 'function') {
    throw new CrossSessionError(
      'NO_SESSION_CONTROLLER',
      `session "${sessionId}" is not currently open, and this DSH build has no Session controller to resume it. Open the session in DSH first, then retry.`,
      { sessionId },
    )
  }

  let found
  try {
    found = await controller.resolveAgent(sessionId)
  } catch (error) {
    if (isAbort(error, undefined)) throw error
    throw remoteFailure(error, sessionId, 'open')
  }
  if (found && typeof found === 'object' && found.error !== undefined) {
    throw remoteFailure(found.error, sessionId, 'open')
  }
  const agent = found && typeof found === 'object' && found.agent !== undefined
    ? found.agent
    : (typeof found?.followup === 'function' ? found : undefined)
  if (agent === undefined || agent === null) {
    throw new CrossSessionError('SESSION_RESUME_FAILED', `session "${sessionId}" could not be resumed as a live Agent.`, { sessionId })
  }
  return { agent, resumed: true }
}

/** Current log length of a live session, used as the "new content" watermark. */
export function baselineSeq (agent) {
  const seq = agent?.session?.seq
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : undefined
}

/** Persist the just-enqueued inbox splice before reporting delivery. */
async function flushSession (ctx, agent) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.flush !== 'function') return undefined
  try {
    return (await sessions.flush(agent.session)) === true
  } catch {
    return false
  }
}

function resolveFilePath (cwd, file) {
  const value = String(file ?? '').trim()
  if (value.length === 0) throw new CrossSessionError('FILE_EMPTY', 'a file path must not be empty.')
  return path.isAbsolute(value) ? value : path.resolve(cwd ?? process.cwd(), value)
}

async function saveAttachments (ctx, config, caller, files, signal) {
  if (!Array.isArray(files) || files.length === 0) return []
  if (files.length > config.maxFiles) {
    throw new CrossSessionError('TOO_MANY_FILES', `at most ${config.maxFiles} files can be sent in one message (got ${files.length}).`)
  }
  const attachments = ctx.get('attachments')
  if (!attachments || typeof attachments.saveFile !== 'function') {
    throw new CrossSessionError(
      'ATTACHMENTS_UNAVAILABLE',
      'this DSH build cannot store file attachments, so files cannot be sent. Include the file path in the message text instead.',
    )
  }
  const refs = []
  for (const file of files) {
    signal?.throwIfAborted()
    const absolute = resolveFilePath(caller.cwd, file)
    let info
    try {
      info = await stat(absolute)
    } catch {
      throw new CrossSessionError('FILE_NOT_FOUND', `attachment "${absolute}" does not exist or is not readable.`, { path: absolute })
    }
    if (!info.isFile()) {
      throw new CrossSessionError('FILE_NOT_REGULAR', `attachment "${absolute}" is not a regular file.`, { path: absolute })
    }
    if (info.size > config.maxFileBytes) {
      throw new CrossSessionError(
        'FILE_TOO_LARGE',
        `attachment "${absolute}" is ${formatBytes(info.size)}; this bridge allows at most ${formatBytes(config.maxFileBytes)} per file.`,
        { path: absolute, bytes: info.size },
      )
    }
    let data
    try {
      data = await readFile(absolute, { signal })
    } catch (error) {
      if (isAbort(error, signal)) throw error
      throw new CrossSessionError('FILE_READ_FAILED', `attachment "${absolute}" could not be read: ${describeError(error)}`, { path: absolute })
    }
    const ref = await attachments.saveFile({ data, name: path.basename(absolute) })
    if (ref === null || typeof ref !== 'object' || typeof ref.attachmentId !== 'string') {
      throw new CrossSessionError('ATTACHMENT_STORE_FAILED', `the attachment store did not return a durable reference for "${absolute}".`, { path: absolute })
    }
    refs.push({ path: absolute, ref })
  }
  return refs
}

function sourceFor (caller, config) {
  if (config.messageSource === 'user') return { kind: 'user' }
  return {
    kind: 'agent-message',
    form: 'relay',
    senderSessionId: caller.id,
  }
}

function composeHeader (caller, expect) {
  const title = caller.title && caller.title.length > 0 ? caller.title : '(untitled)'
  const lines = [
    `[Cross-session message from session "${title}" (${caller.id})]`,
    'This message was sent by another DSH session in the same process, not by the human user. Treat it as a peer-session task message.',
  ]
  if (expect === 'transcript') {
    lines.push('Do the work inside this session and finish your turn. The sender will read this transcript afterwards, so a final written answer in this session is the result — do not send a chat reply unless you need to ask something.')
  } else if (expect === 'reply') {
    lines.push(`When you finish, send the result back with cross_session_send({ to: "${caller.id}", message: "<result>" }).`)
  } else {
    lines.push(`When you finish, send the result back with cross_session_send({ to: "${caller.id}", message: "<result>" }) if a reply is useful. The sender may also read this transcript.`)
  }
  lines.push('---')
  return `${lines.join('\n')}\n`
}

/**
 * Deliver one text/file message to one resolved target session.
 *
 * @param {any} ctx
 * @param {Readonly<Record<string, any>>} config
 * @param {{ id: string, cwd?: string, title?: string }} caller
 * @param {{ id: string, title?: string }} target
 * @param {{ text?: string, files?: string[], mode?: string, expect?: string, signal?: AbortSignal }} input
 * @returns {Promise<{ messageId: string, mode: string, resumed: boolean, durable?: boolean, baselineSeq?: number, files: Array<{ path: string, name: string, bytes?: number }> }>}
 */
export async function deliver (ctx, config, caller, target, input) {
  const text = typeof input.text === 'string' ? input.text : ''
  const files = Array.isArray(input.files) ? input.files : []
  if (text.trim().length === 0 && files.length === 0) {
    throw new CrossSessionError('MESSAGE_EMPTY', 'nothing to send: provide a message and/or at least one file.')
  }
  if (text.length > config.maxMessageChars) {
    throw new CrossSessionError('MESSAGE_TOO_LARGE', `message text is ${text.length} characters; the limit is ${config.maxMessageChars}. Split the work into smaller messages.`, { chars: text.length })
  }

  const mode = input.mode === 'steer' ? 'steer' : 'followup'
  const expect = input.expect === 'reply' || input.expect === 'transcript' ? input.expect : 'auto'
  const saved = await saveAttachments(ctx, config, caller, files, input.signal)

  const content = []
  if (config.includeHeader !== false) content.push({ type: 'text', text: composeHeader(caller, expect) })
  if (text.length > 0) content.push({ type: 'text', text })
  for (const entry of saved) content.push({ type: 'file', attachment: entry.ref })
  if (content.length === 0) {
    throw new CrossSessionError('MESSAGE_EMPTY', 'nothing to send after attachment admission.')
  }

  const { agent, resumed } = await resolveAgent(ctx, target.id)
  const baseline = baselineSeq(agent)
  const message = createUserMessage({ content, source: sourceFor(caller, config) })

  if (mode === 'steer') agent.steer(message)
  else agent.followup(message)

  const durable = await flushSession(ctx, agent)
  return {
    messageId: message.id,
    mode,
    resumed,
    ...(durable === undefined ? {} : { durable }),
    ...(baseline === undefined ? {} : { baselineSeq: baseline }),
    files: saved.map((entry) => ({
      path: entry.path,
      name: typeof entry.ref.name === 'string' ? entry.ref.name : path.basename(entry.path),
      ...(typeof entry.ref.bytes === 'number' ? { bytes: entry.ref.bytes } : {}),
    })),
  }
}

function raceIdle (agent, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(value)
    }
    const timer = setTimeout(() => finish({ idle: false, timedOut: true }), Math.max(0, timeoutMs))
    const onAbort = () => finish({ idle: false, timedOut: false, aborted: true })
    signal?.addEventListener?.('abort', onAbort, { once: true })
    let pending
    try {
      pending = agent.whenIdle()
    } catch (error) {
      finish({ idle: true, error: describeError(error) })
      return
    }
    Promise.resolve(pending).then(
      () => finish({ idle: true, timedOut: false }),
      (error) => finish({ idle: true, timedOut: false, error: describeError(error) }),
    )
  })
}

/**
 * Wait for one session to reach full quiescence.
 *
 * A message enqueued while the target is idle only flips its driver to running
 * on a later microtask, so poll briefly for the start before awaiting
 * `whenIdle()`; otherwise a fast read would return the pre-send transcript.
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @param {{ timeoutMs?: number, signal?: AbortSignal, startGraceMs?: number }} [options]
 * @returns {Promise<{ live: boolean, wasRunning: boolean, started: boolean, idle: boolean, timedOut: boolean, elapsedMs: number, error?: string }>}
 */
export async function waitForTarget (ctx, sessionId, { timeoutMs = 120_000, signal, startGraceMs = 5_000 } = {}) {
  const agent = ctx.get('agents')?.get?.(sessionId)
  if (agent === undefined || agent === null) {
    return { live: false, wasRunning: false, started: false, idle: true, timedOut: false, elapsedMs: 0 }
  }
  const startedAt = Date.now()
  const wasRunning = agent.status === 'running'
  let started = wasRunning
  const grace = Math.max(0, Math.min(startGraceMs, timeoutMs))
  while (!started && Date.now() - startedAt < grace) {
    signal?.throwIfAborted()
    await delay(100, signal)
    started = agent.status === 'running'
  }
  const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt))
  const outcome = await raceIdle(agent, remaining, signal)
  return {
    live: true,
    wasRunning,
    started: started || wasRunning,
    idle: outcome.idle === true,
    timedOut: outcome.timedOut === true,
    elapsedMs: Date.now() - startedAt,
    ...(outcome.aborted === true ? { aborted: true } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  }
}
