/**
 * Minimal fake DSH host for unit tests.
 *
 * No DSH process is involved: `defineTool` is the identity function and the
 * plugin sees only the service slices it actually uses.
 */

import { createHash } from 'node:crypto'

export const defineTool = (options) => options

export function userEvent (seq, text, { source = { kind: 'user' }, time = 1_700_000_000_000 + seq, files = [] } = {}) {
  const content = []
  if (text.length > 0) content.push({ type: 'text', text })
  for (const file of files) content.push({ type: 'file', attachment: file })
  return {
    type: 'user/message',
    seq,
    time,
    data: { role: 'user', content, source, id: `message-${seq}` },
    surfaceOp: 'append',
  }
}

export function assistantEvent (seq, text, { turn = 1, step = 1, toolCalls = [], time = 1_700_000_000_000 + seq } = {}) {
  const content = []
  if (text.length > 0) content.push({ type: 'text', text })
  for (const call of toolCalls) content.push({ type: 'tool-call', ...call })
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn, step, message: { role: 'assistant', content } },
  }
}

export function toolResultEvent (seq, callId, text, { turn = 1, step = 1, time = 1_700_000_000_000 + seq } = {}) {
  return {
    type: 'tool/result',
    seq,
    time,
    data: {
      turn,
      step,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
      },
    },
  }
}

export function titleEvent (seq, title) {
  return { type: 'session/title', seq, time: 1_700_000_000_000 + seq, data: { title, source: { kind: 'fallback' } } }
}

export function createAgent ({ id, status = 'idle', seq = 0, header = {} } = {}) {
  const calls = []
  let resolveIdle
  const idle = new Promise((resolve) => { resolveIdle = resolve })
  const agent = {
    id,
    status,
    session: { id, header, seq },
    calls,
    followup (message) { calls.push({ mode: 'followup', message }) },
    steer (message) { calls.push({ mode: 'steer', message }) },
    whenIdle () { return idle },
    finishIdle () { resolveIdle() },
  }
  return agent
}

export function createHost ({
  sessions = [],
  liveAgents = new Map(),
  liveSessions = new Map(),
  eventsById = new Map(),
  titles = new Map(),
  resolveAgentImpl,
  createImpl,
  renameImpl,
  attachments,
  flushResult = true,
} = {}) {
  let createdCount = 0
  const flushCalls = []
  const services = {
    agents: {
      get: (id) => liveAgents.get(id),
    },
    sessions: {
      get: (id) => liveSessions.get(id),
      list: () => [...liveSessions.values()],
      flush: async (session) => {
        flushCalls.push(session?.id)
        return flushResult
      },
    },
    sessionController: {
      list: async () => ({
        items: sessions.map((session) => ({
          sessionId: session.id,
          updatedAt: session.updatedAt ?? 1_700_000_000_000,
          agentAvailable: liveAgents.has(session.id),
          running: liveAgents.get(session.id)?.status === 'running',
          blank: session.blank === true,
          cwd: session.cwd,
          ...(session.origin !== undefined ? { origin: session.origin } : {}),
          ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
          projections: { values: { title: titles.get(session.id) ?? '' } },
        })),
      }),
      inspect: async (id) => {
        const session = sessions.find((entry) => entry.id === id)
        if (session === undefined) throw new Error(`unknown session ${id}`)
        return { meta: { id, cwd: session.cwd }, events: eventsById.get(id) ?? [] }
      },
      resolveAgent: async (id) => {
        if (typeof resolveAgentImpl === 'function') return resolveAgentImpl(id)
        const existing = liveAgents.get(id)
        if (existing !== undefined) return { agent: existing }
        const session = sessions.find((entry) => entry.id === id)
        if (session === undefined) return { error: { code: 'session/not-found', message: `session "${id}" not found` } }
        const agent = createAgent({ id, header: { cwd: session.cwd, id } })
        liveAgents.set(id, agent)
        return { agent }
      },
      create: async (request) => {
        if (typeof createImpl === 'function') return createImpl(request)
        createdCount += 1
        const sessionId = `session-created-${createdCount}`
        sessions.push({ id: sessionId, cwd: request.cwd, blank: true, updatedAt: Date.now() })
        return { sessionId, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) }
      },
      rename: async ({ sessionId, title }) => {
        if (typeof renameImpl === 'function') return renameImpl({ sessionId, title })
        titles.set(sessionId, title)
        return { title, seq: 1 }
      },
    },
    sessionQuery: {
      readTitle: async (id) => titles.get(id),
      readTitleSnapshots: async (ids) => ids.map((id) => ({
        status: 'fulfilled',
        value: { session: { id }, ...(titles.get(id) === undefined ? {} : { title: titles.get(id) }) },
      })),
    },
    attachments: attachments ?? {
      saveFile: async ({ data, name }) => ({
        attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`,
        name,
        bytes: data.byteLength,
      }),
    },
  }
  const registered = []
  const ctx = {
    get: (name) => services[name],
    tools: { register: (tool) => registered.push(tool) },
    logger: { info: () => {}, error: () => {} },
    registered,
    flushCalls,
  }
  return { ctx, services, registered, flushCalls }
}
