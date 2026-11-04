import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowed, matchesPolicyEntry, callerFromExec, assertOrdinaryCaller } from '../lib/policy.js'
import { normalizeConfig } from '../lib/config.js'

const caller = { id: 'session-A', cwd: 'C:\\work\\alpha' }

function target (overrides = {}) {
  return { id: 'session-B', title: 'Build B', cwd: 'C:\\work\\alpha', ...overrides }
}

test('access=all allows any ordinary peer', () => {
  const config = normalizeConfig({ access: 'all' })
  assert.equal(isAllowed(config, caller, target(), 'send').ok, true)
  assert.equal(isAllowed(config, caller, target({ cwd: 'C:\\elsewhere' }), 'read').ok, true)
})

test('a session cannot address itself', () => {
  const config = normalizeConfig({ access: 'all' })
  const decision = isAllowed(config, caller, target({ id: 'session-A' }), 'send')
  assert.equal(decision.ok, false)
  assert.match(decision.reason, /itself/)
})

test('subagent branches are never addressable', () => {
  const config = normalizeConfig({ access: 'all' })
  assert.equal(isAllowed(config, caller, target({ parentSessionId: 'session-parent' }), 'read').ok, false)
  assert.equal(isAllowed(config, caller, target({ origin: 'subagent' }), 'read').ok, false)
})

test('access=workspace compares the normalized cwd', () => {
  const config = normalizeConfig({ access: 'workspace' })
  assert.equal(isAllowed(config, caller, target(), 'read').ok, true)
  assert.equal(isAllowed(config, caller, target({ cwd: 'C:\\work\\beta' }), 'read').ok, false)
  assert.equal(isAllowed(config, { ...caller, cwd: undefined }, target(), 'read').ok, false)
})

test('access=workspace is case-insensitive on Windows', { skip: process.platform !== 'win32' }, () => {
  const config = normalizeConfig({ access: 'workspace' })
  assert.equal(isAllowed(config, caller, target({ cwd: 'c:\\WORK\\ALPHA' }), 'read').ok, true)
})

test('access=allowlist accepts ids, titles and cwd entries', () => {
  const config = normalizeConfig({ access: 'allowlist', allowlist: ['session-B'] })
  assert.equal(isAllowed(config, caller, target(), 'read').ok, true)
  assert.equal(isAllowed(config, caller, target({ id: 'session-C', title: 'Other' }), 'read').ok, false)

  const byTitle = normalizeConfig({ access: 'allowlist', allowlist: ['build b'] })
  assert.equal(isAllowed(byTitle, caller, target(), 'read').ok, true)

  const byCwd = normalizeConfig({ access: 'allowlist', allowlist: ['cwd:C:\\work\\alpha'] })
  assert.equal(isAllowed(byCwd, caller, target(), 'read').ok, true)
})

test('denylist wins over an open access mode', () => {
  const config = normalizeConfig({ access: 'all', denylist: ['Build B'] })
  const decision = isAllowed(config, caller, target(), 'send')
  assert.equal(decision.ok, false)
  assert.match(decision.reason, /denylist/)
})

test('allowSend / allowRead independently gate actions', () => {
  const noSend = normalizeConfig({ access: 'all', allowSend: false })
  assert.equal(isAllowed(noSend, { id: 'session-A' }, { id: 'session-B' }, 'send').ok, false)
  assert.equal(isAllowed(noSend, { id: 'session-A' }, { id: 'session-B' }, 'read').ok, true)
  const noRead = normalizeConfig({ access: 'all', allowRead: false })
  assert.equal(isAllowed(noRead, { id: 'session-A' }, { id: 'session-B' }, 'read').ok, false)
})

test('policy entries understand id spellings', () => {
  assert.equal(matchesPolicyEntry('session-B', { id: 'session-B', title: '' }), true)
  assert.equal(matchesPolicyEntry('b', { id: 'session-1234-b', title: '' }), false)
  assert.equal(matchesPolicyEntry('*', { id: 'anything', title: '' }), true)
})

test('callerFromExec requires an agent', () => {
  assert.throws(() => callerFromExec({}), /only be called from inside a DSH agent session/)
})

test('callerFromExec detects delegated children', () => {
  const agent = { id: 'session-child', session: { header: { parentSession: 'session-parent', cwd: 'C:\\w' } } }
  const parsed = callerFromExec({ agent })
  assert.equal(parsed.isSubagent, true)
  assert.throws(() => assertOrdinaryCaller(parsed), (error) => error.code === 'SUBAGENT_CALLER')
})

test('invalid config is rejected instead of silently opening access', () => {
  assert.throws(() => normalizeConfig({ access: 'everyone' }), (error) => error.code === 'CONFIG_INVALID')
  assert.throws(() => normalizeConfig({ access: 'workspace', maxWaitSeconds: 0 }), (error) => error.code === 'CONFIG_INVALID')
  assert.throws(() => normalizeConfig({ access: 'workspace', defaultWaitSeconds: 100, maxWaitSeconds: 10 }), (error) => error.code === 'CONFIG_INVALID')
})
