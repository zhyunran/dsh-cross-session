import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { createTools } from '../lib/tools.js'
import { assistantEvent, createAgent, createHost, defineTool, titleEvent, toolResultEvent, userEvent } from './helpers.mjs'

const CWD = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'

function build ({ sessions, liveAgents, eventsById, titles, config } = {}) {
  const host = createHost({ sessions, liveAgents, eventsById, titles })
  const tools = createTools({ defineTool, ctx: host.ctx, config: normalizeConfig(config ?? { access: 'all' }) })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const caller = createAgent({ id: 'session-A', header: { id: 'session-A', cwd: CWD } })
  const exec = { agent: caller, signal: undefined }
  return { ...host, tools, byName, caller, exec }
}

const defaultSessions = () => [
  { id: 'session-A', cwd: CWD, updatedAt: 300 },
  { id: 'session-B', cwd: CWD, updatedAt: 200 },
  { id: 'session-C', cwd: CWD, updatedAt: 100 },
  { id: 'session-sub', cwd: CWD, updatedAt: 150, parentSessionId: 'session-A', origin: 'subagent' },
  { id: 'session-blank', cwd: CWD, updatedAt: 50, blank: true },
]

const defaultTitles = () => new Map([
  ['session-A', 'Alpha 主会话'],
  ['session-B', 'ManageBac 打包要求'],
  ['session-C', 'ManageBac 发布流程'],
])

test('cross_session_list hides self, subagents and blank sessions by default', async () => {
  const { byName, exec } = build({ sessions: defaultSessions(), titles: defaultTitles() })
  const value = await byName.get('cross_session_list').execute({}, exec)
  assert.deepEqual(value.sessions.map((item) => item.id), ['session-B', 'session-C'])
  assert.equal(value.sessions[0].title, 'ManageBac 打包要求')
  assert.equal(value.hidden, 3)
})

test('cross_session_list filters by query and can include self', async () => {
  const { byName, exec } = build({ sessions: defaultSessions(), titles: defaultTitles() })
  const value = await byName.get('cross_session_list').execute({ query: '发布', include_self: true }, exec)
  assert.deepEqual(value.sessions.map((item) => item.id), ['session-C'])
  const withSelf = await byName.get('cross_session_list').execute({ query: '主会话', include_self: true }, exec)
  assert.equal(withSelf.sessions.length, 1)
  assert.equal(withSelf.sessions[0].self, true)
})

test('cross_session_send delivers an attributed, durable message', async () => {
  const host = build({ sessions: defaultSessions(), titles: defaultTitles() })
  const value = await host.byName.get('cross_session_send').execute({ to: 'ManageBac 打包要求', message: '沿用它原来的验收标准' }, host.exec)
  assert.equal(value.deliveries.length, 1)
  assert.equal(value.deliveries[0].ok, true)
  assert.equal(value.deliveries[0].resumed, true)
  assert.equal(value.deliveries[0].durable, true)
  assert.deepEqual(host.flushCalls, ['session-B'])

  const agent = host.ctx.get('agents').get('session-B')
  assert.equal(agent.calls.length, 1)
  assert.equal(agent.calls[0].mode, 'followup')
  const message = agent.calls[0].message
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'agent-message')
  assert.equal(message.source.form, 'relay')
  assert.equal(message.source.senderSessionId, 'session-A')
  assert.match(message.content[0].text, /session-A/)
  assert.match(message.content[0].text, /cross_session_send/)
  assert.equal(message.content[1].text, '沿用它原来的验收标准')
})

test('cross_session_send can fan out to several sessions', async () => {
  const host = build({ sessions: defaultSessions(), titles: defaultTitles() })
  const value = await host.byName.get('cross_session_send').execute({
    to: ['session-B', 'session-C'],
    message: '你们各自复述一遍自己负责的部分',
    expect: 'transcript',
  }, host.exec)
  assert.equal(value.deliveries.filter((entry) => entry.ok).length, 2)
  const message = host.ctx.get('agents').get('session-C').calls[0].message
  assert.match(message.content[0].text, /read this transcript afterwards/)
})

test('cross_session_send copies real files into the attachment store', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cross-session-'))
  try {
    const file = path.join(dir, 'spec.md')
    await writeFile(file, '# spec\nversion 5.1\n', 'utf8')
    const host = build({ sessions: defaultSessions(), titles: defaultTitles() })
    const value = await host.byName.get('cross_session_send').execute({ to: 'session-B', message: '附件是规格', files: [file] }, host.exec)
    assert.equal(value.deliveries[0].ok, true)
    assert.equal(value.deliveries[0].files[0].name, 'spec.md')
    const message = host.ctx.get('agents').get('session-B').calls[0].message
    const fileBlock = message.content.find((block) => block.type === 'file')
    assert.equal(fileBlock.attachment.name, 'spec.md')
    assert.equal(fileBlock.attachment.bytes, 19)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cross_session_send reports policy denial per target instead of aborting the batch', async () => {
  const sessions = [
    { id: 'session-A', cwd: CWD, updatedAt: 300 },
    { id: 'session-B', cwd: CWD, updatedAt: 200 },
    { id: 'session-X', cwd: process.platform === 'win32' ? 'C:\\other' : '/other', updatedAt: 100 },
  ]
  const host = build({ sessions, titles: defaultTitles(), config: { access: 'workspace' } })
  const value = await host.byName.get('cross_session_send').execute({ to: ['session-B', 'session-X'], message: 'hello' }, host.exec)
  assert.equal(value.deliveries[0].ok, true)
  assert.equal(value.deliveries[1].ok, false)
  assert.match(value.deliveries[1].error, /not allowed/)
})

test('cross_session_send refuses self, subagents, and empty payloads', async () => {
  const host = build({ sessions: defaultSessions(), titles: defaultTitles() })
  const self = await host.byName.get('cross_session_send').execute({ to: 'session-A', message: 'hi' }, host.exec)
  assert.equal(self.deliveries[0].ok, false)
  assert.match(self.deliveries[0].error, /itself/)

  const sub = await host.byName.get('cross_session_send').execute({ to: 'session-sub', message: 'hi' }, host.exec)
  assert.equal(sub.deliveries[0].ok, false)
  assert.match(sub.deliveries[0].error, /subagent/i)

  await assert.rejects(host.byName.get('cross_session_send').execute({ to: 'session-B' }, host.exec), (error) => error.code === 'MESSAGE_EMPTY')
})

test('cross_session_send honours mode=steer', async () => {
  const host = build({ sessions: defaultSessions(), titles: defaultTitles() })
  await host.byName.get('cross_session_send').execute({ to: 'session-B', message: '插一句', mode: 'steer' }, host.exec)
  assert.equal(host.ctx.get('agents').get('session-B').calls[0].mode, 'steer')
})

test('cross_session_read returns the original transcript with after_seq and tools', async () => {
  const eventsById = new Map([['session-B', [
    titleEvent(0, 'ManageBac 打包要求'),
    userEvent(1, '要求：保持 5.1'),
    assistantEvent(2, '明白', { toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"x"}' }] }),
    toolResultEvent(3, 'c1', 'x content'),
    assistantEvent(4, '完成', { turn: 1, step: 2 }),
  ]]])
  const host = build({ sessions: defaultSessions(), titles: defaultTitles(), eventsById })
  const tools = await host.byName.get('cross_session_read').execute({ session: 'session-B', include_tools: true }, host.exec)
  assert.equal(tools.session.title, 'ManageBac 打包要求')
  assert.equal(tools.lastSeq, 4)
  assert.deepEqual(tools.entries.map((entry) => entry.role), ['user', 'assistant', 'tool', 'assistant'])
  assert.match(tools.entries[0].text, /保持 5\.1/)

  const tail = await host.byName.get('cross_session_read').execute({ session: 'session-B', after_seq: 4 }, host.exec)
  assert.equal(tail.entries.length, 1)
  assert.equal(tail.entries[0].seq, 4)
})

test('cross_session_search finds requirements and reports misses', async () => {
  const eventsById = new Map([['session-B', [
    titleEvent(0, 'B'),
    userEvent(1, '打包规则：未经指示不要升版本号'),
    assistantEvent(2, '记住了：5.1 保持不变'),
  ]]])
  const host = build({ sessions: defaultSessions(), titles: defaultTitles(), eventsById })
  const hit = await host.byName.get('cross_session_search').execute({ session: 'session-B', query: '升版本号' }, host.exec)
  assert.equal(hit.totalHits, 1)
  assert.equal(hit.hits[0].seq, 1)
  assert.match(hit.hits[0].snippet, /升版本号/)

  const miss = await host.byName.get('cross_session_search').execute({ session: 'session-B', query: '不存在的词' }, host.exec)
  assert.equal(miss.totalHits, 0)
})

test('cross_session_wait waits for idleness and returns the closing assistant message', async () => {
  const eventsById = new Map([['session-B', [
    titleEvent(0, 'B'),
    userEvent(1, 'task'),
    assistantEvent(5, '完成了，结果在 out/result.md'),
  ]]])
  const agent = createAgent({ id: 'session-B', status: 'running', header: { id: 'session-B', cwd: CWD } })
  const liveAgents = new Map([['session-B', agent]])
  const host = build({ sessions: defaultSessions(), titles: defaultTitles(), eventsById, liveAgents })
  setTimeout(() => agent.finishIdle(), 30)
  const value = await host.byName.get('cross_session_wait').execute({ sessions: 'session-B', timeout_seconds: 5 }, host.exec)
  assert.equal(value.results.length, 1)
  assert.equal(value.results[0].idle, true)
  assert.equal(value.results[0].timedOut, false)
  assert.equal(value.results[0].lastAssistant.seq, 5)
  assert.match(value.results[0].lastAssistant.text, /out\/result\.md/)
})

test('cross_session_wait reports a timeout without throwing', async () => {
  const agent = createAgent({ id: 'session-B', status: 'running', header: { id: 'session-B', cwd: CWD } })
  const host = build({ sessions: defaultSessions(), titles: defaultTitles(), liveAgents: new Map([['session-B', agent]]) })
  const value = await host.byName.get('cross_session_wait').execute({ sessions: 'session-B', timeout_seconds: 1 }, host.exec)
  assert.equal(value.results[0].timedOut, true)
  assert.equal(value.results[0].idle, false)
})

test('cross_session_wait treats a cold session as already idle', async () => {
  const host = build({ sessions: defaultSessions(), titles: defaultTitles() })
  const value = await host.byName.get('cross_session_wait').execute({ sessions: 'session-C' }, host.exec)
  assert.equal(value.results[0].live, false)
  assert.equal(value.results[0].idle, true)
})

test('delegated subagent callers are refused', async () => {
  const host = build({ sessions: defaultSessions(), titles: defaultTitles() })
  const child = createAgent({ id: 'session-child', header: { id: 'session-child', cwd: CWD, parentSession: 'session-A' } })
  for (const name of ['cross_session_list', 'cross_session_read', 'cross_session_search', 'cross_session_wait', 'cross_session_send']) {
    await assert.rejects(host.byName.get(name).execute({ to: 'session-B', session: 'session-B', sessions: 'session-B', query: 'x' }, { agent: child }), (error) => error.code === 'SUBAGENT_CALLER')
  }
})
