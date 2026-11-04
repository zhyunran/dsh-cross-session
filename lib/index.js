/**
 * dsh-cross-session — peer-session messaging for DeepSeek Harness.
 *
 * An agent in session A can list, read, search, message and verify another
 * top-level session B: real durable user messages, real file attachments, real
 * turns in B's own conversation. B is a peer session, not a subagent.
 *
 * Design boundaries:
 *   - only top-level sessions: delegated subagent branches are never addressed;
 *   - messages are durable, attributed (`agent-message` + senderSessionId) and
 *     flushed before delivery is reported;
 *   - delivery reuses the same Session-controller path the built-in Schedule
 *     plugin uses, so a cold target is resumed with its own preset and model;
 *   - policy (all / same-workspace / allowlist, plus a denylist) is evaluated on
 *     every call, never cached across a permission change;
 *   - reading is first-class: acceptance reads the peer's own transcript.
 *
 * @module dsh-cross-session
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { normalizeConfig } from './config.js'
import { describeError } from './errors.js'
import { createTools } from './tools.js'

export const name = 'dsh-cross-session'

/** The tool registry is the only hard dependency. Everything else is optional. */
export const inject = ['tools']

function log (ctx, level, message) {
  try {
    ctx.logger?.[level]?.(`dsh-cross-session: ${message}`)
  } catch {
    /* logging must never break plugin load */
  }
}

/**
 * @param {any} ctx plugin context.
 * @param {unknown} rawConfig the `config` block from the profile patch.
 */
export function apply (ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    // A bad config must not prevent DSH from booting (startup is all-or-nothing),
    // and it must not fall back to an open policy. Deny everything instead.
    log(ctx, 'error', `invalid configuration, all cross-session tools will refuse until it is fixed: ${describeError(error)}`)
    config = normalizeConfig({ access: 'allowlist', allowlist: [], allowSend: false, allowRead: false })
  }

  let tools
  try {
    tools = createTools({ defineTool, ctx, config })
  } catch (error) {
    log(ctx, 'error', `tool construction failed, no tools registered: ${describeError(error)}`)
    return
  }

  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      log(ctx, 'error', `could not register ${tool.name}: ${describeError(error)}`)
    }
  }

  log(ctx, 'info', `ready (access=${config.access}, send=${config.allowSend}, read=${config.allowRead})`)
}
