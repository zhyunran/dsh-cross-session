/**
 * Stable, model-readable failures owned by dsh-cross-session.
 *
 * The tool pipeline turns a thrown error into an ordinary error result, so the
 * message is part of the model-facing contract: say what failed and what the
 * caller can do next, never dump an internal stack.
 *
 * @module dsh-cross-session/errors
 */

export class CrossSessionError extends Error {
  /**
   * @param {string} code stable machine code surfaced to logs and callers.
   * @param {string} message model-facing sentence ending in a next step.
   * @param {Record<string, unknown>} [details] extra structured facts.
   */
  constructor (code, message, details = undefined) {
    super(message)
    this.name = 'CrossSessionError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** Render any thrown value as one sentence without leaking a stack. */
export function describeError (error) {
  if (error instanceof CrossSessionError) return `${error.message}${error.code ? ` (${error.code})` : ''}`
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    const code = typeof error.code === 'string' ? ` (${error.code})` : ''
    return `${error.message}${code}`
  }
  return String(error)
}

/** Preserve a RemoteError's stable code while turning it into our vocabulary. */
export function remoteFailure (error, sessionId, action) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN'
  const message = error && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error)
  if (code === 'session/not-found') {
    return new CrossSessionError('SESSION_NOT_FOUND', `session "${sessionId}" was not found. Run cross_session_list to see the sessions this DSH profile can address.`, { sessionId })
  }
  if (code === 'session/writer-held') {
    return new CrossSessionError('SESSION_WRITER_HELD', `session "${sessionId}" already has a different writer in this process, so it cannot be ${action}ed from here.`, { sessionId })
  }
  if (code === 'session/agent-busy') {
    return new CrossSessionError('SESSION_BUSY', `session "${sessionId}" rejected the message because its agent is busy. Retry once the session is idle, or check cross_session_wait.`, { sessionId })
  }
  return new CrossSessionError('SESSION_TARGET_FAILED', `could not ${action} session "${sessionId}": ${message}${code !== 'UNKNOWN' ? ` (${code})` : ''}`, { sessionId })
}
