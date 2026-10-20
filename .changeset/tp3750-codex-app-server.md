---
"@titan-design/agent": minor
---

Add `startCodexAppServer`, a typed client for `codex app-server` over stdio JSON-RPC: the initialize handshake, `threadStart`/`threadResume`, `turnStart` and `turnSteer`, turn and thread-status events, and exit handling that rejects pending calls. A steer that finds no matching active turn rejects with `CodexSteerPreconditionError`, so callers can fall back to `turnStart`.
