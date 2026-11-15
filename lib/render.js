/**
 * Model-facing text rendering for the five tools.
 *
 * The rendered text is what the calling model reads back, so it repeats the
 * identifiers a follow-up call needs and never relies on the model to inspect
 * the JSON value.
 *
 * @module dsh-cross-session/render
 */

import { isoTime } from './util.js'

function stateOf (item) {
  if (item.running) return 'running'
  if (item.live) return 'idle (live)'
  return 'cold (persisted)'
}

function sessionLine (item) {
  const title = item.title && item.title.length > 0 ? item.title : '(untitled)'
  return `"${title}" — ${item.id}`
}

function entryRole (entry) {
  if (entry.role === 'user') {
    const source = entry.source
    if (source?.kind === 'agent-message' && typeof source.senderSessionId === 'string') {
      return `user (agent message from ${source.senderSessionId})`
    }
    if (source?.kind !== undefined && source.kind !== 'user' && source.kind !== 'user-approval') {
      return `user (${String(source.kind)})`
    }
    return 'user'
  }
  if (entry.role === 'tool') return entry.name ? `tool (${entry.name})` : 'tool'
  return 'assistant'
}

/** Render one `cross_session_list` value. */
export function renderList (value) {
  const lines = []
  const total = typeof value.total === 'number' ? value.total : value.sessions?.length ?? 0
  const hidden = typeof value.hidden === 'number' ? value.hidden : 0
  const matched = typeof value.matched === 'number' ? value.matched : value.sessions?.length ?? 0
  const shown = value.sessions?.length ?? 0
  const truncatedByLimit = matched > shown ? ` — showing the first ${shown} of ${matched} matches, raise limit for more` : ''
  lines.push(`Visible sessions: ${shown} of ${total}${hidden > 0 ? ` (${hidden} hidden by filters or policy)` : ''}${truncatedByLimit}.`)
  if (!value.sessions || value.sessions.length === 0) {
    lines.push('No sessions matched. Broaden the query, or set include_blanks/include_subagents/include_self as needed.')
    return lines.join('\n')
  }
  for (const item of value.sessions) {
    lines.push('')
    lines.push(`- ${sessionLine(item)}`)
    lines.push(`  state: ${stateOf(item)}${item.self ? ' | this session' : ''}`)
    if (item.cwd) lines.push(`  cwd: ${item.cwd}`)
    if (item.updatedAt) lines.push(`  updated: ${isoTime(item.updatedAt)}`)
  }
  lines.push('')
  lines.push('Pass an exact session id (or a unique title) as `to` to cross_session_send / _read / _search / _wait.')
  return lines.join('\n')
}

/** Render one `cross_session_create` value. */
export function renderCreate (value) {
  const title = typeof value.title === 'string' && value.title.length > 0 ? `"${value.title}"` : '(untitled)'
  const lines = [`Created top-level session ${title} — ${value.sessionId}.`]
  if (value.cwd) lines.push(`cwd: ${value.cwd}`)
  if (value.workspaceId) lines.push(`workspace: ${value.workspaceId} (attached)`)
  if (value.agentPreset) lines.push(`agent preset: ${value.agentPreset}`)
  if (value.warning) lines.push(`warning: ${value.warning}`)
  if (value.workspaceWarning) lines.push(`workspace warning: ${value.workspaceWarning}`)
  lines.push('The session is blank. Send it its first task with cross_session_send; use cross_session_list({include_blanks:true}) until then.')
  return lines.join('\n')
}

/** Render one `cross_session_send` value. */
export function renderSend (value) {
  const lines = []
  const deliveries = Array.isArray(value.deliveries) ? value.deliveries : []
  const ok = deliveries.filter((entry) => entry.ok).length
  lines.push(`Delivered ${ok}/${deliveries.length} message(s) (mode: ${value.mode}, expect: ${value.expect}).`)
  for (const entry of deliveries) {
    if (!entry.ok) {
      lines.push('')
      lines.push(`- FAILED ${sessionLine(entry.target)}: ${entry.error}`)
      continue
    }
    lines.push('')
    lines.push(`- ${sessionLine(entry.target)}`)
    lines.push(`  message id: ${entry.messageId} | mode: ${entry.mode}${entry.resumed ? ' | target was resumed from disk' : ''}`)
    if (typeof entry.baselineSeq === 'number') lines.push(`  new transcript entries start at seq ${entry.baselineSeq} — pass that as after_seq to cross_session_read later`)
    if (entry.durable === false) lines.push('  durability: persistence did not acknowledge the flush; the message is in memory and may be lost on restart')
    if (entry.files && entry.files.length > 0) {
      lines.push(`  files: ${entry.files.map((file) => `${file.name} (${file.path})`).join('; ')}`)
    }
  }

  if (Array.isArray(value.waited) && value.waited.length > 0) {
    lines.push('')
    lines.push(`Wait results (timeout ${value.timeoutSeconds}s):`)
    for (const result of value.waited) {
      const target = result.session
      lines.push('')
      lines.push(`- ${sessionLine(target)}`)
      if (result.timedOut) lines.push(`  timed out after ${(result.elapsedMs / 1000).toFixed(1)}s; the peer is still working.`)
      else lines.push(`  idle after ${(result.elapsedMs / 1000).toFixed(1)}s.`)
      if (result.error) lines.push(`  warning: ${result.error}`)
      if (result.lastAssistant) {
        lines.push(`  final assistant message [seq ${result.lastAssistant.seq}] ${isoTime(result.lastAssistant.time)}:`)
        lines.push(indent(result.lastAssistant.text))
        if (result.lastAssistant.truncated) lines.push('  (truncated; read the full transcript with cross_session_read)')
      } else {
        lines.push('  no new assistant message yet; read the transcript with cross_session_read after_seq.')
      }
    }
  }

  const failed = deliveries.length - ok
  if (failed > 0) lines.push(`\n${failed} delivery/deliveries failed; fix the target id or policy and retry that target only.`)
  return lines.join('\n')
}

/** Render one `cross_session_read` value. */
export function renderRead (value) {
  const lines = []
  const title = value.session?.title && value.session.title.length > 0 ? value.session.title : '(untitled)'
  lines.push(`Transcript of "${title}" (${value.session?.id}) — last seq ${value.lastSeq}, showing ${value.entries?.length ?? 0} of ${value.totalEntries ?? value.entries?.length ?? 0} entries.`)
  if (value.session?.cwd) lines.push(`cwd: ${value.session.cwd}`)
  if (value.includeTools) lines.push('Tool calls/results are shown because include_tools=true.')
  if (!value.entries || value.entries.length === 0) {
    lines.push('')
    lines.push('No entries matched. Try lowering after_seq or increasing limit.')
    return lines.join('\n')
  }
  for (const entry of value.entries) {
    lines.push('')
    lines.push(`[${entry.seq}] ${isoTime(entry.time)} ${entryRole(entry)}:`)
    lines.push(indent(entry.text))
    if (Array.isArray(entry.tools) && entry.tools.length > 0) {
      lines.push(`  tools: ${entry.tools.join(' | ')}`)
    }
    if (entry.truncated) lines.push('  (truncated; raise max_chars_per_message for this entry)')
  }
  if (value.truncated) lines.push(`\nOlder entries were dropped by limit/after_seq; pass after_seq=${value.entries[0].seq} to page further back.`)
  return lines.join('\n')
}

/** Render one `cross_session_search` value. */
export function renderSearch (value) {
  const lines = []
  const title = value.session?.title && value.session.title.length > 0 ? value.session.title : '(untitled)'
  const terms = Array.isArray(value.terms) ? value.terms.join(' + ') : String(value.query ?? '')
  lines.push(`Search ${JSON.stringify(terms)} in "${title}" (${value.session?.id}): ${value.totalHits ?? 0} matching message(s), scanned ${value.scanned ?? 0}.`)
  if (!value.hits || value.hits.length === 0) {
    lines.push('No matches. Try fewer terms, another session, or include_tools=true for tool output.')
    return lines.join('\n')
  }
  for (const hit of value.hits) {
    lines.push('')
    lines.push(`[${hit.seq}] ${isoTime(hit.time)} ${entryRole(hit)}`)
    lines.push(indent(hit.snippet))
  }
  if (value.truncated) lines.push(`\nMore matches exist than shown; raise limit or narrow the terms.`)
  lines.push('\nFor the surrounding conversation, call cross_session_read with after_seq set just below a hit seq.')
  return lines.join('\n')
}

/** Render one `cross_session_wait` value. */
export function renderWait (value) {
  const lines = []
  const results = Array.isArray(value.results) ? value.results : []
  lines.push(`Waited up to ${value.timeoutSeconds}s for ${results.length} session(s):`)
  for (const result of results) {
    lines.push('')
    lines.push(`- ${sessionLine(result.session)}`)
    if (!result.live) {
      lines.push('  was not open (already idle); nothing to wait for.')
    } else if (result.timedOut) {
      lines.push(`  still working after ${(result.elapsedMs / 1000).toFixed(1)}s (started=${result.started}).`)
    } else {
      lines.push(`  idle after ${(result.elapsedMs / 1000).toFixed(1)}s (wasRunning=${result.wasRunning}).`)
    }
    if (result.error) lines.push(`  warning: ${result.error}`)
    if (result.lastAssistant) {
      lines.push(`  final assistant message [seq ${result.lastAssistant.seq}] ${isoTime(result.lastAssistant.time)}:`)
      lines.push(indent(result.lastAssistant.text))
      if (result.lastAssistant.truncated) lines.push('  (truncated)')
    } else {
      lines.push('  no new assistant message; the peer may not have started or only used tools.')
    }
  }
  lines.push('\nFor acceptance, read each peer\'s own transcript with cross_session_read rather than trusting a returned digest.')
  return lines.join('\n')
}

function indent (text) {
  const body = typeof text === 'string' ? text : String(text ?? '')
  return body.split(/\r?\n/).map((line) => `  ${line}`).join('\n')
}
