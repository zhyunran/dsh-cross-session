import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { createTools } from '../lib/tools.js'
import { createAgent, createHost, defineTool } from './helpers.mjs'

function build ({ config = {}, sessions = [], createImpl, renameImpl } = {}) {
  const host = createHost({ sessions, createImpl, renameImpl })
  const tools = createTools({
    defineTool,
    ctx: host.ctx,
    config: normalizeConfig({ access: 'all', allowCreate: true, ...config }),
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const caller = createAgent({ id: 'session-A', header: { id: 'session-A', cwd: process.cwd() } })
  const exec = { agent: caller, signal: undefined }
  return { ...host, byName, caller, exec }
}

async function tempDir (prefix) {
  return mkdtemp(path.join(tmpdir(), prefix))
}

test('cross_session_create creates a blank top-level session', async () => {
  const root = await tempDir('dsh-create-')
  try {
    const { byName, exec, ctx } = build()
    const value = await byName.get('cross_session_create').execute({ cwd: root, title: 'New work', agent_preset: 'talk' }, exec)
    assert.equal(value.created, true)
    assert.match(value.sessionId, /^session-created-/)
    assert.equal(value.cwd, path.resolve(root))
    assert.equal(value.title, 'New work')
    assert.equal(value.agentPreset, 'talk')
    const list = await ctx.get('sessionController').list()
    assert.equal(list.items.some((item) => item.sessionId === value.sessionId), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cross_session_create is disabled unless allowCreate is explicit', async () => {
  const { byName, exec } = build({ config: { allowCreate: false } })
  await assert.rejects(
    byName.get('cross_session_create').execute({}, exec),
    (error) => error.code === 'CREATE_DISABLED',
  )
})

test('cross_session_create enforces createRoots', async () => {
  const root = await tempDir('dsh-create-root-')
  const outside = await tempDir('dsh-create-outside-')
  try {
    const { byName, exec } = build({ config: { createRoots: [root] } })
    await assert.rejects(
      byName.get('cross_session_create').execute({ cwd: outside }, exec),
      (error) => error.code === 'CREATE_CWD_FORBIDDEN',
    )
    const value = await byName.get('cross_session_create').execute({ cwd: root }, exec)
    assert.equal(value.created, true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('cross_session_create is rate limited per minute', async () => {
  const { byName, exec } = build({ config: { maxCreatePerMinute: 1 } })
  await byName.get('cross_session_create').execute({}, exec)
  await assert.rejects(
    byName.get('cross_session_create').execute({}, exec),
    (error) => error.code === 'CREATE_RATE_LIMITED',
  )
})

test('cross_session_create refuses delegated subagent callers', async () => {
  const { byName, ctx } = build()
  const child = createAgent({ id: 'session-child', header: { id: 'session-child', cwd: process.cwd(), parentSession: 'session-A' } })
  await assert.rejects(
    byName.get('cross_session_create').execute({}, { agent: child, signal: undefined }),
    (error) => error.code === 'SUBAGENT_CALLER',
  )
  assert.equal(typeof ctx.get('sessionController').create, 'function')
})

test('cross_session_create can apply a title but does not undo creation when rename fails', async () => {
  const { byName, exec, ctx } = build({
    renameImpl: async () => { throw new Error('title service unavailable') },
  })
  const value = await byName.get('cross_session_create').execute({ title: 'Will not stick' }, exec)
  assert.equal(value.created, true)
  assert.equal(value.title, 'Will not stick')
  assert.match(value.warning, /title could not be applied/)
  assert.equal(typeof ctx.get('sessionController').create, 'function')
})
