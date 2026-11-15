# dsh-cross-session 0.2.0

**Upgrade:** no breaking change to the five existing tools; creation is opt-in. Add `allowCreate: true` to your `dsh-cross-session` config (the repository's patch already does this).

## Highlights

- New `cross_session_create` tool: create a **blank real top-level DSH session** with its own transcript, model, tools and workspace.
- Optional `cwd`, `title` and `agent_preset`; returns the durable session id.
- Creation stays blank until you send it a task with `cross_session_send`.
- New controls: `createRoots` (absolute workspace allowlist) and `maxCreatePerMinute` (default 5).

## Security / permission boundary

- Creation is a write capability, not read-only discovery.
- Code default is `allowCreate: false`; this repository's `cordis.patch.yml` sets `true` explicitly.
- Subagent callers are refused with `SUBAGENT_CALLER`.
- New sessions do not inherit the caller's task, files or model selection; they use their own preset, workspace and sandbox policy.
- `cross_session_send` still never creates a missing session implicitly.
- Set `createRoots` if this profile is shared, and review `maxCreatePerMinute` before enabling broadly.

## Install / upgrade

```powershell
dsh plugin --profile desktop add C:\path\to\dsh-cross-session-0.2.0.tgz
```

Or install from the GitHub tarball pinned to this release's commit. Restart DSH once after installing.

## Usage

```text
cross_session_create({ cwd: "C:\\work\\project-b", title: "Project B", agent_preset: "talk" })
→ { sessionId, created: true, cwd, title }

cross_session_send({ to: "<sessionId>", message: "First task..." })
```

Blank sessions are hidden by `cross_session_list` by default; use `include_blanks: true` until the first turn.

## Known limitations

- A newly created session receives no automatic first prompt; call `cross_session_send`.
- Title rename is best-effort after creation; a rename failure returns a warning but does not undo the session.
- Requires a DSH build that exposes `sessionController.create`.
- Creation uses the caller's `cwd` unless an absolute existing `cwd` is supplied.

## Tests

49 unit tests pass, including creation success, disabled mode, `createRoots`, rate limiting, subagent refusal and title-rename failure.

Full changelog: https://github.com/zhyunran/dsh-cross-session/blob/main/CHANGELOG.md  
Compare: https://github.com/zhyunran/dsh-cross-session/compare/v0.1.2...v0.2.0
