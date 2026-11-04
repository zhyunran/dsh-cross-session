# Changelog

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
