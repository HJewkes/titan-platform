---
"@titan-design/agent": patch
---

A Codex version or help probe that throws before spawn (for example ENOENT when the CLI is not installed) now fails as `harness_mismatch` instead of `runtime_error`, so the durable dispatcher settles it as terminal `failed` rather than parking it in `recovery_required`. Probe timeouts and aborts keep their existing kinds.
