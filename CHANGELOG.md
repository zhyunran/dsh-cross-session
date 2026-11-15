# Changelog

All notable changes that affect users of this plugin.

## 0.2.1 — 2026-11-15

### Fixed

- `cross_session_create` now attaches a new session to a **registered DSH workspace** when its `cwd` matches one. Previously `create({cwd})` created a real session but did not add it to `workspace.sessionIds`, so a blank session was invisible in the sidebar workspace list even though `cross_session_list` could see it.
- Added an explicit `workspace_id` argument and an `attached`/`workspaceId` result. If no registered workspace matches, creation still succeeds but returns a `workspaceWarning` that the session may not appear in a sidebar.
- Existing hidden sessions are not retroactively attached; create a new one with 0.2.1 after restart.

### Added

- Workspace auto-detection from `cwd`, explicit `workspace_id`, and workspace-conflict validation.

### Tests

- 51 unit tests pass, including workspace auto-attach and explicit `workspace_id`.

## 0.2.0 — 2026-11-15

The minor bump is for a new user-facing capability plus an expanded permission surface; the existing five tools remain backward compatible.

### Migration

- No breaking API change: `cross_session_list`, `cross_session_send`, `cross_session_read`, `cross_session_search` and `cross_session_wait` keep their arguments and behavior.
- New creation is opt-in in the code (`allowCreate: false`). The `cordis.patch.yml` shipped in this repository enables it explicitly. If your profile has its own `dsh-cross-session` config block, add `allowCreate: true` there to enable it; otherwise the tool fails with `CREATE_DISABLED`.
- Review `createRoots` before enabling in a shared or multi-workspace profile.

### Security

- `cross_session_create` creates a real top-level Session, so it is a new write capability, not another read alias. It is limited to ordinary top-level callers; delegated subagents are refused with `SUBAGENT_CALLER`.
- Creation does not inherit a task, files or a model selection from the caller. The new Session stays blank until a later `cross_session_send`; it uses its own workspace, preset, model and sandbox policy.
- Deployment controls: `allowCreate` (off in code, on in the repository patch), `createRoots` (absolute directory allowlist) and `maxCreatePerMinute` (default 5). Limit exhaustion returns `CREATE_RATE_LIMITED`; a forbidden cwd returns `CREATE_CWD_FORBIDDEN`.
- `cross_session_send` still never creates a missing session implicitly; an unknown target remains `SESSION_NOT_FOUND`.

### Added

- `cross_session_create`: create a blank top-level Session with optional existing absolute `cwd`, `title` and `agent_preset`; returns the durable `sessionId`.
- Creation helper with cwd validation, optional title rename and explicit non-fatal warning if title rename fails.
- Config fields `allowCreate`, `createRoots` and `maxCreatePerMinute`.
- Blank-session discovery note: use `cross_session_list({ include_blanks: true })` until the new Session's first turn.

### Changed

- The plugin now registers six tools instead of five.
- The startup log reports `create=` alongside `access`, `send` and `read`.
- Documentation and Chinese/English READMEs describe the new tool, its permission controls and its blank-session behavior.

### Tests

- 49 unit tests pass (was 43), including creation success, disabled mode, `createRoots`, rate limiting, subagent refusal and title-rename failure.

Compare: https://github.com/zhyunran/dsh-cross-session/compare/v0.1.2...v0.2.0

## 0.1.2 — 2026-11-04

- `cross_session_list` now merges Sessions that exist only in the live process (for example a conversation opened moments ago, before the query index/persistence has a row). Their title is read from the live log, so a just-created session is addressable by name.
- `live` now means "the Session object is loaded in this process", independent of whether its Agent is currently available.
- 43 unit tests.

## 0.1.1 — 2026-11-03

- Clarify in `cross_session_send`'s model-facing description that an array `to` fan-out delivers the **same** text to every target, and that per-session distinct instructions are sent by calling the tool once per session. This is the C/D/E workflow from the original request.

## 0.1.0 — 2026-11-03

First public release.

- **5 tools**: `cross_session_list`, `cross_session_send`, `cross_session_read`, `cross_session_search`, `cross_session_wait`.
- Delivery reuses the Session-controller path (`resolveAgent` → `followup`/`steer` → `sessions.flush`), so cold peer sessions are resumed with their own preset/model and the message is durable before success is reported.
- Real file attachments: bytes are copied into DSH's durable attachment store and delivered as `file` blocks.
- Honest attribution: delivered messages carry `source.kind = "agent-message"` with `senderSessionId`; optional `messageSource: user` for human-looking messages.
- Acceptance by transcript: read/search a peer's durable log; `cross_session_wait` returns the peer's final assistant message read from its own log.
- Policy: `all` / `workspace` / `allowlist`, plus `denylist`, independent read/send switches, all evaluated per call; invalid config degrades to deny-all instead of opening access or breaking boot.
- Subagent branches and self-addressing are refused.
- English and Chinese documentation; 42 unit tests and a real `defineTool` schema-compile check.
