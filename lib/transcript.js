/**
 * Turn a DSH session event log into readable, searchable transcript entries.
 *
 * Only durable, model-visible surface events are interpreted:
 *   - `user/message`      → one user entry (text, files, images, sender source)
 *   - `assistant/message` → one assistant entry (text; tool calls on request)
 *   - `tool/result`       → one tool entry, only when tools are requested
 *   - `session/title`     → the session title
 *
 * Streaming frames, inbox splices, request headers and other log-only facts are
 * deliberately ignored: this is the conversation a human would read.
 *
 * @module dsh-cross-session/transcript
 */

import { truncate } from './util.js'

const MAX_ARG_SUMMARY = 220
const HAYSTACK_CAP = 200_000

function blockText (block) {
  if (block === null || typeof block !== 'object') return ''
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : ''
    case 'file': {
      const ref = block.attachment ?? {}
      const name = typeof ref.name === 'string' && ref.name.length > 0 ? ref.name : 'file'
      const bytes = typeof ref.bytes === 'number' ? `, ${ref.bytes} bytes` : ''
      return `[file: ${name}${bytes}]`
    }
    case 'image': {
      const ref = block.attachment ?? {}
      const name = typeof ref.name === 'string' && ref.name.length > 0 ? ref.name : 'image'
      return `[image: ${name}]`
    }
    default:
      return ''
  }
}

function toolCallSummary (block, max = MAX_ARG_SUMMARY) {
  const name = typeof block.name === 'string' ? block.name : 'tool'
  const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
  const cut = truncate(args, max)
  return `${name}(${cut.text})`
}

function collectBlocks (content, { includeToolCalls }) {
  const textParts = []
  const files = []
  const toolCalls = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) textParts.push(block.text)
    } else if (block.type === 'file') {
      const ref = block.attachment ?? {}
      files.push(typeof ref.name === 'string' && ref.name.length > 0 ? ref.name : 'file')
      textParts.push(blockText(block))
    } else if (block.type === 'image') {
      textParts.push(blockText(block))
    } else if (block.type === 'reasoning') {
      // Reasoning is intentionally excluded: it is not part of the conversation
      // the user reads, and it can dominate a transcript.
    } else if (includeToolCalls && block.type === 'tool-call') {
      toolCalls.push(toolCallSummary(block))
    }
  }
  return { text: textParts.join('\n'), files, toolCalls }
}

function userEntry (event, options) {
  const data = event.data ?? {}
  const blocks = collectBlocks(data.content, options)
  const source = data.source ?? {}
  const text = blocks.text.trim()
  if (text.length === 0 && blocks.files.length === 0) return undefined
  return {
    seq: event.seq,
    time: event.time,
    role: 'user',
    text: text.length > 0 ? text : `[attached files: ${blocks.files.join(', ')}]`,
    files: blocks.files.length > 0 ? blocks.files : undefined,
    source: {
      kind: typeof source.kind === 'string' ? source.kind : 'unknown',
      ...(typeof source.senderSessionId === 'string' ? { senderSessionId: source.senderSessionId } : {}),
    },
  }
}

function assistantEntry (event, options) {
  const data = event.data ?? {}
  const message = data.message ?? data
  const blocks = collectBlocks(message?.content, options)
  if (blocks.text.trim().length === 0 && blocks.toolCalls.length === 0) return undefined
  return {
    seq: event.seq,
    time: event.time,
    role: 'assistant',
    ...(typeof data.turn === 'number' ? { turn: data.turn } : {}),
    ...(typeof data.step === 'number' ? { step: data.step } : {}),
    text: blocks.text.trim(),
    tools: blocks.toolCalls.length > 0 ? blocks.toolCalls : undefined,
  }
}

/**
 * Project events into transcript entries.
 *
 * @param {ReadonlyArray<Record<string, any>>} events
 * @param {{ includeTools?: boolean, maxChars?: number, afterSeq?: number }} [options]
 * @returns {{ entries: Array<Record<string, any>>, title: string, lastSeq: number }}
 */
export function transcriptFromEvents (events, options = {}) {
  const includeTools = options.includeTools === true
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : 2000
  const afterSeq = Number.isFinite(options.afterSeq) ? options.afterSeq : undefined
  const entries = []
  let title = ''
  let lastSeq = -1
  const toolNames = new Map()

  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    if (seq !== undefined && seq > lastSeq) lastSeq = seq

    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      title = event.data.title
      continue
    }
    if (afterSeq !== undefined && (seq === undefined || seq < afterSeq)) continue

    let entry
    if (event.type === 'user/message') entry = userEntry(event, { includeToolCalls: false })
    else if (event.type === 'assistant/message') entry = assistantEntry(event, { includeToolCalls: includeTools })
    else if (includeTools && event.type === 'tool/call' && typeof event.data?.callId === 'string') {
      toolNames.set(event.data.callId, typeof event.data.name === 'string' ? event.data.name : 'tool')
      continue
    } else if (includeTools && event.type === 'tool/result') {
      const message = event.data?.message ?? {}
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
      const text = collectBlocks(message.content, { includeToolCalls: false }).text.trim()
      if (text.length === 0) continue
      entry = {
        seq,
        time: event.time,
        role: 'tool',
        ...(callId !== undefined ? { callId } : {}),
        name: callId !== undefined ? toolNames.get(callId) : undefined,
        text,
      }
    }
    if (entry === undefined) continue
    if (typeof entry.text === 'string' && entry.text.length > maxChars) {
      const cut = truncate(entry.text, maxChars)
      entry.text = cut.text
      entry.truncated = true
    }
    entries.push(entry)
  }

  return { entries, title, lastSeq }
}

/**
 * Return the closing assistant message of the last turn, ignoring anything at
 * or before `afterSeq`. This is the acceptance artifact: the peer's own final
 * words, read from its log rather than from a returned envelope.
 *
 * @param {ReadonlyArray<Record<string, any>>} events
 * @param {{ afterSeq?: number, maxChars?: number }} [options]
 * @returns {null | { seq: number, time: number, turn?: number, text: string, truncated?: boolean }}
 */
export function lastAssistant (events, { afterSeq, maxChars = 8000 } = {}) {
  const { entries } = transcriptFromEvents(events, { includeTools: false, maxChars: Math.max(maxChars, HAYSTACK_CAP) })
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.role !== 'assistant') continue
    if (Number.isFinite(afterSeq) && typeof entry.seq === 'number' && entry.seq < afterSeq) return null
    if (typeof entry.text !== 'string' || entry.text.trim().length === 0) continue
    const cut = truncate(entry.text.trim(), maxChars)
    return {
      seq: entry.seq,
      time: entry.time,
      ...(entry.turn !== undefined ? { turn: entry.turn } : {}),
      text: cut.text,
      ...(cut.truncated ? { truncated: true } : {}),
    }
  }
  return null
}

function excerpt (text, index, termLength, context) {
  const radius = Math.max(40, Number(context) || 160)
  const start = Math.max(0, index - Math.floor(radius / 2))
  const end = Math.min(text.length, index + termLength + Math.ceil(radius / 2))
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/**
 * Literal, case-insensitive search across transcript entries. Every
 * whitespace-separated term must appear in the same entry.
 *
 * @param {ReadonlyArray<Record<string, any>>} events
 * @param {string} query
 * @param {{ includeTools?: boolean, limit?: number, context?: number, caseSensitive?: boolean, afterSeq?: number }} [options]
 * @returns {{ hits: Array<Record<string, any>>, totalHits: number, scanned: number, terms: string[], truncated: boolean }}
 */
export function searchEvents (events, query, options = {}) {
  const raw = String(query ?? '').trim()
  if (raw.length === 0) return { hits: [], totalHits: 0, scanned: 0, terms: [], truncated: false }
  const terms = raw.split(/\s+/).filter((term) => term.length > 0)
  const caseSensitive = options.caseSensitive === true
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 10
  const context = Number.isFinite(options.context) ? options.context : 160
  const { entries } = transcriptFromEvents(events, {
    includeTools: options.includeTools === true,
    maxChars: HAYSTACK_CAP,
    afterSeq: Number.isFinite(options.afterSeq) ? options.afterSeq : undefined,
  })

  const hits = []
  let totalHits = 0
  for (const entry of entries) {
    const haystackParts = [entry.text ?? '']
    if (Array.isArray(entry.tools)) haystackParts.push(entry.tools.join('\n'))
    if (typeof entry.name === 'string') haystackParts.push(entry.name)
    const haystack = haystackParts.join('\n')
    const folded = caseSensitive ? haystack : haystack.toLowerCase()
    const needles = caseSensitive ? terms : terms.map((term) => term.toLowerCase())
    if (!needles.every((term) => folded.includes(term))) continue
    totalHits += 1
    if (hits.length >= limit) continue
    const first = needles[0]
    const index = Math.max(0, folded.indexOf(first))
    hits.push({
      seq: entry.seq,
      time: entry.time,
      role: entry.role,
      ...(entry.turn !== undefined ? { turn: entry.turn } : {}),
      ...(entry.source !== undefined ? { source: entry.source } : {}),
      snippet: excerpt(haystack, index, first.length, context),
    })
  }

  return {
    hits,
    totalHits,
    scanned: entries.length,
    terms,
    truncated: totalHits > hits.length,
  }
}
