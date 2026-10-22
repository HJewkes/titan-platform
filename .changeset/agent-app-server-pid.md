---
"@titan-design/agent": minor
---

Codex app-server client: `CodexAppServer` now exposes `pid`, the spawned process id (also its process group id). The client, its types and its error classes (`startCodexAppServer`, `CodexSteerPreconditionError`, `CodexAppServerRpcError`, `CodexAppServerExitedError`) are exported from the package entry point.
