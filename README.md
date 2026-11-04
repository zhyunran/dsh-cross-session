# dsh-cross-session

**Let an agent in one DSH session talk to another real DSH session — send messages, hand over files, search its history, and read its own final answer. Peer sessions, not subagents.**

[中文说明](README.zh.md)

---

## Why this exists

Subagents are cheap to spawn but expensive to trust: they share your turn, your context window and your failure mode. A *real* session — one you can open in the sidebar, give its own model, its own tools, its own long-running history — is often the better worker. But until now an agent had no way to reach one.

`dsh-cross-session` gives an agent five tools to treat other top-level DSH sessions as peers:

| Tool | What it does |
|---|---|
| `cross_session_list` | List the other sessions, with exact id / title / cwd / state. Resolve "session B", "the C/D/E sessions" by name. |
| `cross_session_send` | Send a message and/or **real file attachments** into one or many sessions. The target wakes and works on it as its own normal turn. |
| `cross_session_read` | Read the peer's **original transcript** — user messages, assistant replies, optionally tool calls/results. Works on cold sessions. |
| `cross_session_search` | Search a peer's entire conversation for literal terms (all terms must appear in one message). |
| `cross_session_wait` | Wait until one or many peers are fully idle, then return each one's final assistant message read from its log. |

The last two are the important ones: **acceptance is reading the peer's own conversation**, not trusting a returned envelope. That is the difference between "delegate and hope" and real cross-session development.

## What it feels like

**Reuse another session's requirements**

> User: finish the packaging task, with the same requirements as session B.
>
> Agent: `cross_session_search({ session: "ManageBac 打包要求", query: "版本号 changelog" })` → reads the exact rules → does the work.

**Command a small fleet**

> User: C, D and E each did part of this project — they know more. Tell them to finish their part.
>
> Agent: `cross_session_send({ to: ["C", "D", "E"], message: "...", expect: "transcript" })` → three peer sessions start working.
>
> Later: `cross_session_wait({ sessions: ["C","D","E"] })` → `cross_session_read` each transcript → verify their actual output.

**Ask a peer a question**

> `cross_session_send({ to: "session-B", message: "What did we decide about the installer?", expect: "reply" })`
>
> The peer replies with `cross_session_send` back to you, or you read its transcript after `cross_session_wait`.

## Install

Requires **DSH 0.2.x** (desktop or `dsh web`). The plugin is a normal DSH bundle; it has no build step and no runtime dependencies beyond the host's `@deepseek-ai/dsh-tools`.

### Option A — DSH plugin manager (recommended)

1. Download the package:
   - `dsh-cross-session-0.1.2.tgz` from the GitHub release / repo `dist/`, **or** clone this repo.
2. Open **DSH → Settings → Plugins** and install the bundle from:
   - a local tarball path (`.../dsh-cross-session-0.1.2.tgz`), or
   - a local directory containing `package.json`, or
   - a GitHub URL if your DSH build supports remote bundle specs.
3. Restart DSH once so the host loads the new bundle.

### Option B — CLI

```powershell
# local tarball (absolute path; a relative path is rejected by the installer)
dsh plugin --profile desktop add C:\path\to\dsh-cross-session-0.1.2.tgz

# or a GitHub tarball (works without git installed)
dsh plugin --profile desktop add https://codeload.github.com/<owner>/dsh-cross-session/tar.gz/<40-char-commit>

# if published to npm
dsh plugin --profile desktop add dsh-cross-session
```

Then restart DSH. The plugin registers itself through `cordis.patch.yml`, so no manual edit of your profile is required.

### Verify

Ask the agent:

> List the other sessions in this DSH.

It should call `cross_session_list` and show real session titles. If the tools are missing, the bundle did not load — check **Settings → Plugins** and restart once.

### Status

- 43 unit tests pass against a fake host (`node --test test/*.test.mjs`).
- Tool declarations compile with the real `dsh-tools` schema compiler.
- End-to-end verified on an isolated DSH **0.2.0-rc.2** web instance: A listed B, sent B a message plus a real file attachment, B read the attachment and finished its own turn, A's `wait` returned B's final text; A then searched and read B's transcript; B replied back with `cross_session_send` and A was woken by the incoming message; a cold B was resumed by the tool on first contact.

## Configuration

Defaults are intentionally usable out of the box: **any top-level session in this profile may address any other**. DSH is a local, single-user harness; installing the plugin is the permission grant. If you want a tighter policy, override the entry in your own profile layer:

```yaml
# <DSH_HOME>/profiles/<profile>/cordis.patch.yml
- id: dsh-cross-session
  config:
    access: workspace          # all | workspace | allowlist
    allowlist: []              # ids, exact titles, or "cwd:<absolute path>"
    denylist: []               # never listed, read or written
    allowSend: true
    allowRead: true
    includeHeader: true
    messageSource: agent-message   # agent-message | user
```

| Field | Default | Meaning |
|---|---|---|
| `access` | `all` | `all` = every top-level session; `workspace` = only sessions with the same `cwd`; `allowlist` = only entries in `allowlist`. |
| `allowlist` | `[]` | Used by `access: allowlist`. Accepts session ids, exact titles, or `cwd:<path>`. `*` matches everything. |
| `denylist` | `[]` | Always denied, under every access mode. Same vocabulary as `allowlist`. |
| `allowSend` / `allowRead` | `true` | Independently disable writes or reads. |
| `includeHeader` | `true` | Prefix a header naming the sender id, explaining this is a peer message, and naming the reply tool. |
| `messageSource` | `agent-message` | `agent-message` gives honest peer attribution (`senderSessionId`) and renders as "task message received" in the peer UI. `user` makes it look like a human message. |
| `maxFileBytes` | 25 MiB | Largest single attachment copied into the append-only attachment store. |
| `maxFiles` | 8 | Attachments per message. |
| `maxMessageChars` | 100000 | Message text cap. |
| `maxTranscriptChars` | 60000 | Cap for one read/wait response. |
| `maxEvents` | 20000 | Event-scan safety cap for read/search. |
| `defaultReadLimit` | 20 | Default entries returned by `cross_session_read`. |
| `defaultSearchLimit` | 10 | Default hits returned by `cross_session_search`. |
| `defaultWaitSeconds` | 120 | Default wait budget. |
| `maxWaitSeconds` | 600 | Hard wait ceiling. |

A malformed config never opens access: the plugin logs the error and falls back to a deny-all policy instead of preventing DSH from booting.

## Tool reference

### `cross_session_list`

```jsonc
{
  "query": "ManageBac",      // optional: title / id / cwd substring
  "include_self": false,
  "include_subagents": false,
  "include_blanks": false,
  "limit": 20                 // max 50
}
```

Returns `{ total, matched, hidden, sessions[] }` with `id`, `title`, `cwd`, `updatedAt`, `running`, `live`, `blank`, `self`.

### `cross_session_send`

```jsonc
{
  "to": "ManageBac 打包要求",       // id or unique title; string OR string[]
  "message": "…",
  "files": ["C:\\\\work\\\\spec.md"],  // absolute or relative to this session's cwd
  "mode": "followup",              // followup (next turn) | steer (current step)
  "expect": "auto",                // auto | reply | transcript
  "wait": false,                   // true = block until peers idle, return final text
  "timeout_seconds": 120
}
```

- `to` accepts one target or an array for fan-out. Fan-out sends the **same** message; for per-session instructions, call once per session.
- `files` are copied byte-for-byte into DSH's durable attachment store and arrive as real `file` blocks in the target conversation — readable by the peer's model and visible to its user.
- `mode: "followup"` queues for the next turn and wakes the target. `mode: "steer"` interjects at the target's next step if it is already running.
- `expect` only controls the guidance written into the delivered message:
  - `transcript` — "finish in your own session; the sender will read your transcript" (best for acceptance-by-reading);
  - `reply` — "send the result back with `cross_session_send`";
  - `auto` — reply if useful; the sender may also read.
- Delivery is flushed through `ctx.sessions.flush` before success is reported, and a **cold** target is resumed through the Session controller with its own preset/model selection.
- The result includes `baselineSeq`; pass it as `after_seq` to `cross_session_read` later to see exactly what is new.

### `cross_session_read`

```jsonc
{
  "session": "session-…",
  "limit": 20,                    // most recent entries, max 200
  "after_seq": 1234,              // only entries at/after this seq (incremental polling)
  "include_tools": false,         // include tool calls/results
  "max_chars_per_message": 2000
}
```

Reads the durable log through `Session.inspect` for both live and cold sessions; no Agent is activated. Entries are `{ seq, time, role, source?, tools?, text }`.

### `cross_session_search`

```jsonc
{
  "session": "session-…",
  "query": "版本号 changelog",     // all whitespace-separated terms must appear in one message
  "limit": 10,
  "context_chars": 160,
  "include_tools": false,
  "case_sensitive": false,
  "after_seq": 0
}
```

Returns snippets with `seq`, `time`, `role`; follow up with `cross_session_read({ after_seq: hit.seq - 50 })` for context.

### `cross_session_wait`

```jsonc
{
  "sessions": ["C", "D", "E"],
  "timeout_seconds": 120,   // total budget shared across all targets
  "after_seq": 1234         // only report assistant messages at/after this seq
}
```

Returns one row per target: `{ live, wasRunning, started, idle, timedOut, elapsedMs, lastAssistant?, error? }`. Timeouts are reported, not thrown, so partial progress survives.

## How it works

```
 A (agent turn)
   │  cross_session_send
   ▼
 resolveSession by id/title ──► ctx.sessionController.resolveAgent(target)
   │                               ├─ live? use it
   │                               └─ cold? resume with its own preset + model
   ├─ files → ctx.attachments.saveFile(bytes) → FileAttachmentRef
   ├─ createUserMessage(content, { kind:'agent-message', form:'relay', senderSessionId:A })
   ├─ agent.followup(message)  (or agent.steer)
   └─ ctx.sessions.flush(agent.session)   ← durability barrier
        │
        ▼
 B's own agent loop: inbox → user/message → model turn → assistant/message → turn/end
        │
        ▼
 A later: cross_session_read / _search / _wait  → reads B's durable log
```

This is the same delivery path the built-in **Schedule** feature uses (`resolveAgent` → `followup` → `flush`). No session files are hand-edited, no subagent is spawned, and the target session stays a first-class conversation with its own model, tools, workspace and history.

## Display and wake-up behavior (read this)

- **The target agent runs immediately**, whether or not its conversation is open.
- **If the target conversation is open** in a DSH client, the message and the new turn appear live.
- **If it is not open**, the message is durable but the client only renders it when that conversation is opened (click it in the sidebar). This is a client-follow behavior, not a delivery failure; the peer already worked on it.
- Installing or upgrading the plugin requires **one DSH restart** so the host loads the new bundle. After that, no restart is needed per message.
- A peer's UI shows the message with an "agent message" trigger when `messageSource: agent-message` is used. Set `messageSource: user` if you want it to look exactly like human input.

## Safety and limits

- Only **top-level** sessions are addressable. Delegated subagent branches (and Agent Teams member branches) are filtered out and refused with an explicit error.
- A session cannot address itself; a subagent caller is refused (it must report to its parent).
- `access` and `denylist` are evaluated on every call, including list/read/search, so a policy change takes effect immediately.
- `cross_session_send` validates target ids; ambiguous titles return the candidate list instead of guessing.
- Messages and files are durable; file bytes are content-addressed and deduplicated by the attachment store.
- Wait budgets are capped by `maxWaitSeconds`; use `after_seq` + `cross_session_read` for long-running peers instead of blocking forever.
- Do not create mutual waits (A waits for B while B waits for A); they time out by design.
- Reading a very large session is capped by `maxEvents` and `maxTranscriptChars`; the result says when it was truncated.

## Known limitations

- DSH `0.2.x` only; the plugin depends on `ctx.sessionController.resolveAgent()`, `Agent.followup/steer`, and the session event vocabulary of this line.
- No session creation/deletion: this plugin addresses sessions that already exist. Create a new chat in the UI first if you need a fresh peer.
- No broadcast of *different* messages in one call; call once per distinct instruction.
- Tool output is text; there is no custom UI card yet.
- `messageSource: user` makes the peer message look human but also means a peer without a title may derive its title from it.

## Development

```powershell
# unit tests (no DSH required; fake host)
node --test test/*.test.mjs

# compile the tool declarations with the real dsh-tools schema compiler
# (schema-check/ carries an extracted copy; see schema-check/check.mjs)
node ../schema-check/check.mjs

# package
npm pack
```

Layout:

```
lib/index.js       plugin entry (name / inject / apply)
lib/config.js      validated policy
lib/policy.js      who may see/address whom
lib/discovery.js   session listing, title resolution
lib/transcript.js  event log → readable entries + search
lib/transport.js   resume, deliver, flush, wait
lib/tools.js       the five tool definitions
lib/render.js      model-facing text
test/              unit tests with a fake host
schema-check/      real defineTool compile check (not shipped)
```

## Publishing this package

The repository is already an uploadable package (no build step):

```powershell
git init
git add .
git commit -m "dsh-cross-session 0.1.2"
git branch -M main
git remote add origin https://github.com/<owner>/dsh-cross-session.git
git push -u origin main
```

Then create a GitHub release `v0.1.2` and attach `dist/dsh-cross-session-0.1.2.tgz`. Two install paths work for other users:

```powershell
# GitHub tarball (git not required)
dsh plugin --profile <profile> add https://codeload.github.com/<owner>/dsh-cross-session/tar.gz/<40-char-commit>

# or the release asset downloaded locally
dsh plugin --profile <profile> add C:\path\to\dsh-cross-session-0.1.2.tgz
```

To publish to npm instead: `npm publish --access public` (the manifest already declares `publishConfig`).

## License

MIT. See [LICENSE](LICENSE).

---

Built for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). If this saves you from spawning one more subagent, it did its job.
