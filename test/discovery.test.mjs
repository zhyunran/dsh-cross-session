import assert from 'node:assert/strict'
import test from 'node:test'
import { listSessions, resolveSession, titleOf } from '../lib/discovery.js'
import { createHost } from './helpers.mjs'

function host () {
  const sessions = [
    { id: 'session-A', cwd: 'C:\\work', updatedAt: 300 },
    { id: 'session-B', cwd: 'C:\\work', updatedAt: 200 },
    { id: 'session-C', cwd: 'C:\\work', updatedAt: 100 },
    { id: 'session-sub', cwd: 'C:\\work', updatedAt: 150, parentSessionId: 'session-A', origin: 'subagent' },
    { id: 'session-blank', cwd: 'C:\\work', updatedAt: 50, blank: true },
  ]
  const titles = new Map([
    ['session-A', 'Alpha 主会话'],
    ['session-B', 'ManageBac 打包要求'],
    ['session-C', 'ManageBac 发布流程'],
  ])
  const { ctx } = createHost({ sessions, titles })
  return { ctx }
}

test('listSessions returns everything ordered by activity with titles', async () => {
  const { ctx } = host()
  const items = await listSessions(ctx)
  assert.deepEqual(items.map((item) => item.id), [
    'session-A',
    'session-B',
    'session-sub',
    'session-C',
    'session-blank',
  ])
  assert.equal(items[0].title, 'Alpha 主会话')
  assert.equal(items[2].parentSessionId, 'session-A')
  assert.equal(items[4].blank, true)
})

test('resolveSession accepts exact id, bare uuid spelling, and exact title', async () => {
  const { ctx } = host()
  assert.equal((await resolveSession(ctx, 'session-B')).id, 'session-B')
  assert.equal((await resolveSession(ctx, 'ManageBac 打包要求')).id, 'session-B')
  assert.equal((await resolveSession(ctx, 'managebac 打包要求')).id, 'session-B')
})

test('resolveSession accepts a unique prefix', async () => {
  const { ctx } = host()
  assert.equal((await resolveSession(ctx, 'Alpha')).id, 'session-A')
})

test('resolveSession reports ambiguity instead of guessing', async () => {
  const { ctx } = host()
  await assert.rejects(resolveSession(ctx, 'ManageBac'), (error) => {
    assert.equal(error.code, 'SESSION_AMBIGUOUS')
    assert.match(error.message, /ManageBac 打包要求/)
    assert.match(error.message, /ManageBac 发布流程/)
    return true
  })
})

test('resolveSession refuses a subagent branch by exact id', async () => {
  const { ctx } = host()
  await assert.rejects(resolveSession(ctx, 'session-sub'), (error) => error.code === 'SUBAGENT_SESSION')
})

test('resolveSession reports a helpful miss', async () => {
  const { ctx } = host()
  await assert.rejects(resolveSession(ctx, 'does not exist'), (error) => {
    assert.equal(error.code, 'SESSION_NOT_FOUND')
    assert.match(error.message, /cross_session_list/)
    return true
  })
})

test('titleOf folds the latest logged title for cold sessions', async () => {
  const { ctx } = host()
  assert.equal(await titleOf(ctx, 'session-B'), 'ManageBac 打包要求')
  assert.equal(await titleOf(ctx, 'session-unknown'), '')
})

test('listSessions merges a live session that the query index does not know yet', async () => {
  const live = {
    id: 'session-just-opened',
    header: { id: 'session-just-opened', cwd: 'C:\\work', createdAt: 9_999_999_999 },
    seq: 0,
    snapshotEvents: () => [
      { type: 'session/title', seq: 0, time: 9_999_999_999, data: { title: '刚开的会话' } },
    ],
  }
  const { ctx } = createHost({
    sessions: [{ id: 'session-B', cwd: 'C:\\work', updatedAt: 200 }],
    titles: new Map([['session-B', 'B']]),
    liveSessions: new Map([['session-just-opened', live]]),
  })
  const items = await listSessions(ctx)
  const found = items.find((item) => item.id === 'session-just-opened')
  assert.ok(found, 'live-only session is listed')
  assert.equal(found.title, '刚开的会话')
  assert.equal(found.live, true)
})

test('listSessions falls back to persistence when the controller is absent', async () => {
  const sessions = [
    { header: { id: 'session-P', cwd: 'C:\\work', createdAt: 10 } },
    { header: { id: 'session-Q', cwd: 'C:\\other', createdAt: 20 } },
  ]
  const ctx = {
    get: (name) => {
      if (name === 'sessions') return { list: () => [] }
      if (name === 'sessionPersistence') return { list: async () => sessions.map((header) => ({ header: header.header })) }
      return undefined
    },
  }
  const items = await listSessions(ctx)
  assert.deepEqual(items.map((item) => item.id), ['session-Q', 'session-P'])
})
