/**
 * Create a real top-level DSH Session through the Session controller.
 *
 * This is deliberately separate from delivery: creation has its own policy,
 * rate limit and path validation, and the new Session is a normal blank peer
 * with its own durable transcript, tools, model and workspace.
 *
 * @module dsh-cross-session/create
 */

import path from 'node:path'
import { stat } from 'node:fs/promises'
import { CrossSessionError, describeError } from './errors.js'

function unwrap (value) {
  if (value !== null && typeof value === 'object' && value.ok === true && 'value' in value) return value.value
  if (value !== null && typeof value === 'object' && value.error !== undefined && value.ok !== true) {
    throw value.error
  }
  return value
}

function insideRoot (candidate, root) {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  let relative
  try {
    relative = path.relative(resolvedRoot, resolvedCandidate)
  } catch {
    return false
  }
  if (process.platform === 'win32') {
    relative = relative.toLowerCase()
  }
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Validate a create request before touching the host.
 *
 * @param {{ cwd?: string, title?: string, agentPreset?: string }} request
 * @param {{ cwd?: string }} caller
 * @param {Readonly<Record<string, any>>} config
 * @returns {Promise<{ cwd?: string, title?: string, agentPreset?: string }>}
 */
export async function normalizeCreateRequest (request, caller, config) {
  const rawCwd = typeof request.cwd === 'string' ? request.cwd.trim() : ''
  const cwd = rawCwd.length > 0 ? rawCwd : caller.cwd
  let normalizedCwd
  if (cwd !== undefined && cwd !== null && String(cwd).trim().length > 0) {
    if (!path.isAbsolute(String(cwd))) {
      throw new CrossSessionError('CREATE_CWD_INVALID', 'cwd must be an absolute path; relative paths are ambiguous for a new top-level session.')
    }
    normalizedCwd = path.resolve(String(cwd))
    let info
    try {
      info = await stat(normalizedCwd)
    } catch {
      throw new CrossSessionError('CREATE_CWD_MISSING', `cwd "${normalizedCwd}" does not exist; create the directory first or pass an existing workspace.`)
    }
    if (!info.isDirectory()) {
      throw new CrossSessionError('CREATE_CWD_INVALID', `cwd "${normalizedCwd}" is not a directory.`)
    }
    if (config.createRoots.length > 0 && !config.createRoots.some((root) => insideRoot(normalizedCwd, root))) {
      throw new CrossSessionError(
        'CREATE_CWD_FORBIDDEN',
        `cwd "${normalizedCwd}" is outside every configured createRoots entry. Ask the deployment owner to add that root, or create inside an allowed workspace.`,
      )
    }
  } else if (config.createRoots.length > 0) {
    throw new CrossSessionError('CREATE_CWD_REQUIRED', 'this deployment restricts creation to configured roots; pass an absolute cwd inside one of them.')
  }

  const title = typeof request.title === 'string' ? request.title.trim() : ''
  if (title.length > 200) {
    throw new CrossSessionError('CREATE_TITLE_INVALID', 'title must be at most 200 characters.')
  }
  const agentPreset = typeof request.agentPreset === 'string' ? request.agentPreset.trim() : ''
  if (agentPreset.length > 100) {
    throw new CrossSessionError('CREATE_PRESET_INVALID', 'agentPreset must be at most 100 characters.')
  }

  return {
    ...(normalizedCwd === undefined ? {} : { cwd: normalizedCwd }),
    ...(title.length === 0 ? {} : { title }),
    ...(agentPreset.length === 0 ? {} : { agentPreset }),
  }
}

/**
 * Create one blank ordinary Session.
 *
 * @param {any} ctx plugin context.
 * @param {{ id: string, cwd?: string }} caller verified ordinary caller.
 * @param {{ cwd?: string, title?: string, agentPreset?: string }} request validated request.
 * @param {Readonly<Record<string, any>>} config effective policy.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function createTopLevelSession (ctx, caller, request, config) {
  if (config.allowCreate !== true) {
    throw new CrossSessionError(
      'CREATE_DISABLED',
      'creating top-level sessions is disabled by config.allowCreate; ask the deployment owner to enable it explicitly.',
    )
  }

  const controller = ctx.get('sessionController')
  if (!controller || typeof controller.create !== 'function') {
    throw new CrossSessionError(
      'NO_SESSION_CONTROLLER',
      'this DSH build does not expose sessionController.create, so a top-level session cannot be created from a tool.',
    )
  }

  let created
  try {
    const payload = {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
    }
    created = unwrap(await controller.create(payload))
  } catch (error) {
    throw new CrossSessionError(
      'SESSION_CREATE_FAILED',
      `could not create a top-level session: ${describeError(error)}`,
    )
  }

  const sessionId = created !== null && typeof created === 'object' && typeof created.sessionId === 'string'
    ? created.sessionId
    : undefined
  if (sessionId === undefined) {
    throw new CrossSessionError('SESSION_CREATE_FAILED', 'the Session controller returned no sessionId; no session was created.')
  }

  let title = request.title ?? null
  let titleWarning
  if (request.title !== undefined) {
    if (typeof controller.rename !== 'function') {
      titleWarning = 'the session was created, but this DSH build cannot set a title before the first turn.'
    } else {
      try {
        const renamed = unwrap(await controller.rename({ sessionId, title: request.title }))
        if (renamed !== null && typeof renamed === 'object' && typeof renamed.title === 'string') title = renamed.title
      } catch (error) {
        titleWarning = `the session was created, but the title could not be applied: ${describeError(error)}`
      }
    }
  }

  return {
    sessionId,
    created: true,
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(created !== null && typeof created === 'object' && typeof created.agentPreset === 'string'
      ? { agentPreset: created.agentPreset }
      : (request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset })),
    ...(title === null ? {} : { title }),
    ...(titleWarning === undefined ? {} : { warning: titleWarning }),
    note: 'The session is blank. Give it its first task with cross_session_send to its id; use include_blanks:true when listing it before that turn.',
  }
}
