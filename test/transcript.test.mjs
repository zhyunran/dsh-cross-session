import assert from 'node:assert/strict'
import test from 'node:test'
import { lastAssistant, searchEvents, transcriptFromEvents } from '../lib/transcript.js'
import { assistantEvent, titleEvent, toolResultEvent, userEvent } from './helpers.mjs'

const fileRef = { attachmentId: 'sha256:abc', name: 'plan.pdf', bytes: 1234 }

function events () {
  return [
    titleEvent(0, '打包要求'),
    userEvent(1, '请按 B 会话的要求完成打包'),
    assistantEvent(2, '收到，我先看要求。', { turn: 1, step: 1, toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"path":"spec.md"}' }] }),
    { type: 'tool/call', seq: 3, time: 1_700_000_000_003, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"spec.md"}' } },
    toolResultEvent(4, 'call-1', 'spec content: version 5.1, no bump without approval', { turn: 1, step: 1 }),
    assistantEvent(5, '结论：保持 5.1，补齐 changelog。', { turn: 1, step: 1 }),
    userEvent(6, '把附件也带上', { files: [fileRef], source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-A' } }),
  ]
}

test('projects messages, titles, and attachment markers', () => {
  const result = transcriptFromEvents(events(), { maxChars: 10_000 })
  assert.equal(result.title, '打包要求')
  assert.equal(result.lastSeq, 6)
  assert.deepEqual(result.entries.map((entry) => entry.role), ['user', 'assistant', 'assistant', 'user'])
  assert.match(result.entries[0].text, /打包/)
  assert.match(result.entries[3].text, /plan\.pdf/)
  assert.deepEqual(result.entries[3].files, ['plan.pdf'])
  assert.equal(result.entries[3].source.kind, 'agent-message')
  assert.equal(result.entries[3].source.senderSessionId, 'session-A')
})

test('tool calls and results are opt-in', () => {
  const without = transcriptFromEvents(events(), { maxChars: 10_000 })
  assert.equal(without.entries.some((entry) => entry.role === 'tool'), false)

  const withTools = transcriptFromEvents(events(), { includeTools: true, maxChars: 10_000 })
  assert.equal(withTools.entries.some((entry) => entry.role === 'tool'), true)
  const assistant = withTools.entries.find((entry) => entry.role === 'assistant')
  assert.match(assistant.tools[0], /^read\(/)
  const tool = withTools.entries.find((entry) => entry.role === 'tool')
  assert.equal(tool.name, 'read')
  assert.match(tool.text, /version 5\.1/)
})

test('afterSeq filters and per-entry truncation is marked', () => {
  const result = transcriptFromEvents(events(), { maxChars: 12, afterSeq: 5 })
  assert.deepEqual(result.entries.map((entry) => entry.seq), [5, 6])
  assert.equal(result.entries[0].truncated, true)
  assert.ok(result.entries[0].text.length <= 12)
})

test('lastAssistant returns the peer closing message only', () => {
  const final = lastAssistant(events(), { maxChars: 500 })
  assert.equal(final.seq, 5)
  assert.match(final.text, /保持 5\.1/)
  assert.equal(lastAssistant(events(), { afterSeq: 6 }), null)
})

test('search requires every term and reports snippets', () => {
  const result = searchEvents(events(), '版本 5.1', { limit: 10, context: 120 })
  assert.equal(result.totalHits, 0)

  const hit = searchEvents(events(), '保持 5.1', { limit: 10, context: 120 })
  assert.equal(hit.totalHits, 1)
  assert.equal(hit.hits[0].seq, 5)
  assert.match(hit.hits[0].snippet, /保持 5\.1/)
})

test('search is case-insensitive unless asked not to be', () => {
  assert.equal(searchEvents(events(), 'CHANGELOG').totalHits, 1)
  assert.equal(searchEvents(events(), 'CHANGELOG', { caseSensitive: true }).totalHits, 0)
})

test('search can include tool output and truncates beyond the limit', () => {
  assert.equal(searchEvents(events(), 'spec content').totalHits, 0)
  assert.equal(searchEvents(events(), 'spec content', { includeTools: true }).totalHits, 1)

  const many = [userEvent(1, 'alpha one'), userEvent(2, 'alpha two'), userEvent(3, 'alpha three')]
  const limited = searchEvents(many, 'alpha', { limit: 2 })
  assert.equal(limited.totalHits, 3)
  assert.equal(limited.hits.length, 2)
  assert.equal(limited.truncated, true)
})

test('an empty query never matches', () => {
  assert.equal(searchEvents(events(), '   ').totalHits, 0)
})
