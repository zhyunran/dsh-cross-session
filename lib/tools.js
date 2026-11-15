/**
 * The five model-facing tools.
 *
 * Naming contract: `cross_session_*` is deliberately narrow and greppable so a
 * user can tell at a glance which calls can touch another conversation.
 *
 * @module dsh-cross-session/tools
 */

import { createTopLevelSession, normalizeCreateRequest } from './create.js'
import { listSessions, resolveSession, titleOf } from './discovery.js'
import { CrossSessionError, describeError } from './errors.js'
import { assertAllowed, assertOrdinaryCaller, callerFromExec, isAllowed, isSubagentItem } from './policy.js'
import { renderCreate, renderList, renderRead, renderSearch, renderSend, renderWait } from './render.js'
import { lastAssistant, searchEvents, transcriptFromEvents } from './transcript.js'
import { deliver, readSessionLog, waitForTarget } from './transport.js'
import { asArray, isAbort } from './util.js'

const MAX_LIST_LIMIT = 50
const MAX_READ_LIMIT = 200

function intArg (value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback
  const number = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new CrossSessionError('ARG_INVALID', `${name} must be a number.`)
  }
  const integer = Math.floor(number)
  if (integer < min || integer > max) {
    throw new CrossSessionError('ARG_INVALID', `${name} must be between ${min} and ${max} (got ${integer}).`)
  }
  return integer
}

function boolArg (value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function refsArg (value, name) {
  const refs = asArray(value)
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0)
  if (refs.length === 0) {
    throw new CrossSessionError('SESSION_REF_EMPTY', `${name} needs at least one session id or title. Run cross_session_list first.`)
  }
  return [...new Set(refs)]
}

function publicTarget (target) {
  return {
    id: target.id,
    ...(target.title ? { title: target.title } : {}),
    ...(target.cwd ? { cwd: target.cwd } : {}),
  }
}

function entryView (entry) {
  return {
    seq: entry.seq,
    time: entry.time,
    role: entry.role,
    ...(entry.turn !== undefined ? { turn: entry.turn } : {}),
    ...(entry.source !== undefined ? { source: entry.source } : {}),
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...(entry.tools !== undefined ? { tools: entry.tools } : {}),
    ...(entry.truncated === true ? { truncated: true } : {}),
    text: entry.text,
  }
}

async function callerOf (ctx, exec) {
  const caller = callerFromExec(exec)
  assertOrdinaryCaller(caller)
  try {
    caller.title = await titleOf(ctx, caller.id, exec.signal)
  } catch {
    caller.title = ''
  }
  return caller
}

function matchesQuery (item, query) {
  if (query.length === 0) return true
  const needle = query.toLowerCase()
  return (item.title ?? '').toLowerCase().includes(needle)
    || item.id.toLowerCase().includes(needle)
    || (item.cwd ?? '').toLowerCase().includes(needle)
}

/**
 * Build the tool set for one plugin instance.
 *
 * @param {{ defineTool: Function, ctx: any, config: Readonly<Record<string, any>> }} input
 * @returns {Array<Record<string, any>>}
 */
export function createTools ({ defineTool, ctx, config }) {
  const creationTimes = []
  const list = defineTool({
    name: 'cross_session_list',
    description:
      'List the other top-level DSH sessions in this profile, live or persisted, with the exact id/title/cwd/state needed to address them. ' +
      'Use this before cross_session_send/read/search/wait when you only know a session by name (for example "session B" or "the C/D/E sessions"). ' +
      'These are peer sessions, NOT subagents: each has its own transcript, tools, model and client tab. ' +
      'Subagent branches are not addressable and are hidden by default. ' +
      'You can also list by name with query.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive substring matched against title, id and cwd.' },
      include_self: { type: 'boolean', description: 'Include the calling session in the result. Default false.' },
      include_subagents: { type: 'boolean', description: 'Include delegated subagent branches (they cannot be messaged). Default false.' },
      include_blanks: { type: 'boolean', description: 'Include sessions that have never run a turn. Default false.' },
      limit: { type: 'integer', description: 'Maximum rows to return (default 20, max 50).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderList(value) }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 120_000,
    async execute (args, exec) {
      const caller = await callerOf(ctx, exec)
      const query = String(args.query ?? '').trim()
      const includeSelf = boolArg(args.include_self, false)
      const includeSubagents = boolArg(args.include_subagents, false)
      const includeBlanks = boolArg(args.include_blanks, false)
      const limit = intArg(args.limit, 20, 1, MAX_LIST_LIMIT, 'limit')

      const items = await listSessions(ctx, { signal: exec.signal })
      const matched = []
      for (const item of items) {
        const self = item.id === caller.id
        if (!includeSubagents && isSubagentItem(item)) continue
        if (!includeSelf && self) continue
        if (!includeBlanks && item.blank) continue
        // Listing oneself is discovery, not peer inspection: the self guard in
        // the policy applies to addressing, not to seeing your own row.
        if (!self && !isAllowed(config, caller, item, 'read').ok) continue
        if (!matchesQuery(item, query)) continue
        matched.push({ ...item, self: item.id === caller.id })
      }

      return {
        total: items.length,
        matched: matched.length,
        hidden: Math.max(0, items.length - matched.length),
        query,
        limit,
        sessions: matched.slice(0, limit).map((item) => ({
          id: item.id,
          title: item.title,
          ...(item.cwd ? { cwd: item.cwd } : {}),
          updatedAt: item.updatedAt,
          running: item.running,
          live: item.live,
          blank: item.blank,
          ...(item.self ? { self: true } : {}),
        })),
      }
    },
  })

  const create = defineTool({
    name: 'cross_session_create',
    description:
      'Create a NEW blank top-level DSH session in this profile, with its own durable transcript, tools, model and workspace. ' +
      'This is a peer session, NOT a subagent: it can be listed and messaged with the other cross_session_* tools. ' +
      'Creation is a side effect, so call it only when the user explicitly wants a new conversation. ' +
      'Pass `cwd` to choose an existing absolute workspace (default: this session\'s cwd); if that path is a registered DSH workspace, the new session is attached to it and appears in the sidebar. ' +
      'The new session is blank; give it the first task with cross_session_send using the returned id. ' +
      'Because cross_session_list hides blank sessions by default, list it with include_blanks:true before its first turn. ' +
      'Subagent sessions cannot create peers; deployments may disable this tool or restrict createRoots.',
    parameters: {
      cwd: { type: 'string', description: 'Optional absolute existing directory for the new session\'s workspace. Defaults to this session\'s cwd. If it matches a registered DSH workspace, the session is attached there and appears in the sidebar.' },
      workspace_id: { type: 'string', description: 'Optional registered DSH workspace id. Overrides cwd for attachment; omit to auto-detect from cwd.' },
      title: { type: 'string', description: 'Optional title (max 200 characters). It is applied after creation; failure to rename does not undo creation.' },
      agent_preset: { type: 'string', description: 'Optional agent preset id for the new session. Omit to use the deployment default.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderCreate(value) }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 120_000,
    async execute (args, exec) {
      const caller = await callerOf(ctx, exec)
      if (config.allowCreate !== true) {
        throw new CrossSessionError('CREATE_DISABLED', 'creating top-level sessions is disabled by config.allowCreate; ask the deployment owner to enable it explicitly.')
      }
      const request = await normalizeCreateRequest({
        cwd: args.cwd,
        workspaceId: args.workspace_id,
        title: args.title,
        agentPreset: args.agent_preset,
      }, caller, config)

      const now = Date.now()
      while (creationTimes.length > 0 && now - creationTimes[0] >= 60_000) creationTimes.shift()
      if (creationTimes.length >= config.maxCreatePerMinute) {
        throw new CrossSessionError(
          'CREATE_RATE_LIMITED',
          `this deployment allows at most ${config.maxCreatePerMinute} new top-level sessions per minute; wait before creating another.`,
        )
      }

      const created = await createTopLevelSession(ctx, caller, request, config)
      creationTimes.push(Date.now())
      return created
    },
  })

  const send = defineTool({
    name: 'cross_session_send',
    description:
      'Send a message and/or file attachments from THIS session into one or more other top-level DSH sessions, exactly like a person typing in those conversations. ' +
      'Each target wakes and works on it as its own normal session — a peer session, not a subagent, with its own transcript, context and tools. ' +
      '`to` accepts one session id/title or an array of them (fan-out to C, D, E in one call). ' +
      'A fan-out delivers the same text to every target; when each session needs different instructions, call the tool once per session (reuse the ids from cross_session_list). ' +
      '`files` are copied into DSH\'s durable attachment store and arrive as real file attachments in the target conversation, readable by both its model and its user. ' +
      'The target sees an attribution header naming this session and telling it to reply with cross_session_send back to this id. ' +
      'Delivery is durable and wakes a cold target by resuming it through the Session controller. ' +
      'The message may not appear in the target\'s client until that conversation is opened; the target agent still runs immediately. ' +
      'Workflow: send with expect="transcript" when you will verify by reading; then call cross_session_read or cross_session_wait to read the peer\'s own final answer. ' +
      'Avoid mutual waits (A waits for B while B waits for A) — they time out. Prefer async: send, do other work, then read.',
    parameters: {
      to: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        required: true,
        description: 'Target session id (from cross_session_list) or unique title; a string or an array of strings for fan-out.',
      },
      message: { type: 'string', description: 'Message text to deliver. Required unless files are sent.' },
      files: { type: 'array', items: { type: 'string' }, description: 'File paths to attach (absolute, or relative to this session\'s cwd). Copied byte-for-byte into the durable attachment store.' },
      mode: { type: 'string', enum: ['followup', 'steer'], description: 'followup (default): queue for the target\'s next turn and wake it. steer: inject into the target\'s current running turn at its next step.' },
      expect: { type: 'string', enum: ['auto', 'reply', 'transcript'], description: 'auto (default): tell the peer to reply if useful. reply: require a reply message. transcript: tell the peer to finish in its own session and NOT send a chat reply — use this when you will accept by reading the transcript.' },
      wait: { type: 'boolean', description: 'When true, block this turn until every successfully targeted session is idle, then return each one\'s final assistant message read from its transcript. Default false (async).' },
      timeout_seconds: { type: 'integer', description: 'Total wait budget in seconds when wait=true (default 120, max 600).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderSend(value) }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 660_000,
    async execute (args, exec) {
      const caller = await callerOf(ctx, exec)
      const refs = refsArg(args.to, 'to')
      const text = typeof args.message === 'string' ? args.message : ''
      const files = asArray(args.files).map((entry) => String(entry ?? '')).filter((entry) => entry.trim().length > 0)
      if (text.trim().length === 0 && files.length === 0) {
        throw new CrossSessionError('MESSAGE_EMPTY', 'provide `message` and/or at least one path in `files`.')
      }
      const mode = args.mode === 'steer' ? 'steer' : 'followup'
      const expect = args.expect === 'reply' || args.expect === 'transcript' ? args.expect : 'auto'
      const wait = boolArg(args.wait, false)
      const timeoutSeconds = intArg(args.timeout_seconds, config.defaultWaitSeconds, 1, config.maxWaitSeconds, 'timeout_seconds')

      const deliveries = []
      const delivered = []
      for (const ref of refs) {
        try {
          const target = await resolveSession(ctx, ref, { signal: exec.signal })
          assertAllowed(config, caller, target, 'send')
          const result = await deliver(ctx, config, caller, target, { text, files, mode, expect, signal: exec.signal })
          deliveries.push({ target: publicTarget(target), ok: true, ...result })
          delivered.push({ target, result })
        } catch (error) {
          if (isAbort(error, exec.signal)) throw error
          deliveries.push({
            target: { id: ref, title: ref },
            ok: false,
            error: describeError(error),
          })
        }
      }

      const waited = []
      if (wait && delivered.length > 0) {
        const deadline = Date.now() + timeoutSeconds * 1000
        for (const { target, result } of delivered) {
          const remaining = Math.max(250, deadline - Date.now())
          const status = await waitForTarget(ctx, target.id, { timeoutMs: remaining, signal: exec.signal })
          let final = null
          let readError
          try {
            const log = await readSessionLog(ctx, target.id, exec.signal)
            final = lastAssistant(log.events, { afterSeq: result.baselineSeq })
          } catch (error) {
            if (isAbort(error, exec.signal)) throw error
            readError = describeError(error)
          }
          waited.push({
            session: publicTarget(target),
            ...status,
            ...(final === null ? {} : { lastAssistant: final }),
            ...(readError === undefined ? {} : { error: readError }),
          })
        }
      }

      return { mode, expect, timeoutSeconds, deliveries, ...(waited.length > 0 ? { waited } : {}) }
    },
  })

  const read = defineTool({
    name: 'cross_session_read',
    description:
      'Read the original transcript of another top-level DSH session — the same conversation a human would see: user messages (including cross-session ones), assistant replies, and optionally tool calls/results. ' +
      'Use it to learn another session\'s requirements and history (for example "make it match session B\'s dev requirements"), or to ACCEPT delegated work by reading the peer\'s own final answer instead of trusting a returned message. ' +
      'Reads from the durable log, works on cold sessions, and cannot be satisfied by a summary. ' +
      'Pass after_seq to fetch only what is new since a previous read (incremental polling).',
    parameters: {
      session: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        required: true,
        description: 'Session id or unique title. If an array is passed, only the first entry is read (use cross_session_read once per session).',
      },
      limit: { type: 'integer', description: 'Number of most recent transcript entries to return (default 20, max 200).' },
      after_seq: { type: 'integer', description: 'Only include entries whose event sequence is >= this value. Use the lastSeq from a previous read to poll.' },
      include_tools: { type: 'boolean', description: 'Include assistant tool calls and tool results as transcript entries. Default false (messages only).' },
      max_chars_per_message: { type: 'integer', description: 'Truncate each entry to this many characters (default 2000, max 20000).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 180_000,
    async execute (args, exec) {
      const caller = await callerOf(ctx, exec)
      const refs = refsArg(args.session, 'session')
      const target = await resolveSession(ctx, refs[0], { signal: exec.signal })
      assertAllowed(config, caller, target, 'read')
      const log = await readSessionLog(ctx, target.id, exec.signal)
      const limit = intArg(args.limit, config.defaultReadLimit, 1, MAX_READ_LIMIT, 'limit')
      const afterSeq = args.after_seq === undefined ? undefined : intArg(args.after_seq, 0, 0, Number.MAX_SAFE_INTEGER, 'after_seq')
      const includeTools = boolArg(args.include_tools, false)
      const maxChars = intArg(args.max_chars_per_message, 2000, 100, 20_000, 'max_chars_per_message')
      const capped = log.events.length > config.maxEvents ? log.events.slice(-config.maxEvents) : log.events
      const projected = transcriptFromEvents(capped, { includeTools, maxChars, afterSeq })
      const selected = projected.entries.slice(-limit)
      return {
        session: {
          id: target.id,
          title: projected.title || target.title,
          ...(target.cwd ? { cwd: target.cwd } : {}),
        },
        lastSeq: projected.lastSeq,
        totalEntries: projected.entries.length,
        truncated: projected.entries.length > selected.length || capped.length !== log.events.length,
        includeTools,
        ...(capped.length !== log.events.length ? { eventsCappedAt: config.maxEvents } : {}),
        entries: selected.map(entryView),
      }
    },
  })

  const search = defineTool({
    name: 'cross_session_search',
    description:
      'Search another top-level DSH session\'s entire conversation for literal, case-insensitive terms; every whitespace-separated term must appear in the same message. ' +
      'Use it when the user references a name, file, decision or requirement discussed in another session ("search session B for the packaging rules") and you need the exact wording rather than a guess. ' +
      'Searches user and assistant messages by default; set include_tools=true to search tool calls and tool output too. ' +
      'Results are snippets with seq numbers; follow up with cross_session_read(after_seq=hit.seq-…) for the surrounding conversation.',
    parameters: {
      session: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        required: true,
        description: 'Session id or unique title. If an array is passed, only the first entry is searched (call once per session).',
      },
      query: { type: 'string', required: true, description: 'Literal terms; all must appear in one message. e.g. "打包 版本" or "ManageBac installer".' },
      limit: { type: 'integer', description: 'Maximum hits to return (default 10, max 50).' },
      context_chars: { type: 'integer', description: 'Approximate characters of surrounding context in each snippet (default 160).' },
      include_tools: { type: 'boolean', description: 'Also search assistant tool calls and tool results. Default false.' },
      case_sensitive: { type: 'boolean', description: 'Match case exactly. Default false.' },
      after_seq: { type: 'integer', description: 'Only search entries with event sequence >= this value.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 180_000,
    async execute (args, exec) {
      const caller = await callerOf(ctx, exec)
      const refs = refsArg(args.session, 'session')
      const query = String(args.query ?? '').trim()
      if (query.length === 0) throw new CrossSessionError('ARG_INVALID', 'query must contain at least one non-whitespace term.')
      const target = await resolveSession(ctx, refs[0], { signal: exec.signal })
      assertAllowed(config, caller, target, 'read')
      const log = await readSessionLog(ctx, target.id, exec.signal)
      const capped = log.events.length > config.maxEvents ? log.events.slice(-config.maxEvents) : log.events
      const result = searchEvents(capped, query, {
        includeTools: boolArg(args.include_tools, false),
        limit: intArg(args.limit, config.defaultSearchLimit, 1, 50, 'limit'),
        context: intArg(args.context_chars, 160, 40, 2000, 'context_chars'),
        caseSensitive: boolArg(args.case_sensitive, false),
        afterSeq: args.after_seq === undefined ? undefined : intArg(args.after_seq, 0, 0, Number.MAX_SAFE_INTEGER, 'after_seq'),
      })
      return {
        session: {
          id: target.id,
          title: target.title,
          ...(target.cwd ? { cwd: target.cwd } : {}),
        },
        query,
        ...result,
        ...(capped.length !== log.events.length ? { eventsCappedAt: config.maxEvents } : {}),
      }
    },
  })

  const wait = defineTool({
    name: 'cross_session_wait',
    description:
      'Wait until one or more peer sessions are fully idle (current turn and queued work finished), then return each one\'s final assistant message read from its durable transcript. ' +
      'Use this after sending work to peers when they may not reply by message, or to verify that a fan-out to C, D and E all finished before accepting. ' +
      'A cold session is already idle and returns immediately. Timeouts are reported per target, not thrown, so partial progress is visible. ' +
      'Acceptance rule: read the peer\'s own transcript (cross_session_read) rather than trusting a returned digest.',
    parameters: {
      sessions: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        required: true,
        description: 'Session ids or unique titles; a string or an array for a batch (C, D, E).',
      },
      timeout_seconds: { type: 'integer', description: 'Total wait budget in seconds (default 120, max 600), shared across all targets.' },
      after_seq: { type: 'integer', description: 'Only report an assistant message with event sequence >= this value.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderWait(value) }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 660_000,
    async execute (args, exec) {
      const caller = await callerOf(ctx, exec)
      const refs = refsArg(args.sessions, 'sessions')
      const timeoutSeconds = intArg(args.timeout_seconds, config.defaultWaitSeconds, 1, config.maxWaitSeconds, 'timeout_seconds')
      const afterSeq = args.after_seq === undefined ? undefined : intArg(args.after_seq, 0, 0, Number.MAX_SAFE_INTEGER, 'after_seq')
      const deadline = Date.now() + timeoutSeconds * 1000
      const results = []
      for (const ref of refs) {
        let target
        try {
          target = await resolveSession(ctx, ref, { signal: exec.signal })
          assertAllowed(config, caller, target, 'read')
        } catch (error) {
          if (isAbort(error, exec.signal)) throw error
          results.push({ session: { id: ref, title: ref }, live: false, idle: false, timedOut: false, wasRunning: false, started: false, elapsedMs: 0, error: describeError(error) })
          continue
        }
        const remaining = Math.max(250, deadline - Date.now())
        const status = await waitForTarget(ctx, target.id, { timeoutMs: remaining, signal: exec.signal })
        let final = null
        let readError
        try {
          const log = await readSessionLog(ctx, target.id, exec.signal)
          final = lastAssistant(log.events, { afterSeq })
        } catch (error) {
          if (isAbort(error, exec.signal)) throw error
          readError = describeError(error)
        }
        results.push({
          session: publicTarget(target),
          ...status,
          ...(final === null ? {} : { lastAssistant: final }),
          ...(readError === undefined ? {} : { error: readError }),
        })
      }
      return { timeoutSeconds, results }
    },
  })

  return [list, create, send, read, search, wait]
}
