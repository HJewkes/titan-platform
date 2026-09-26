---
"@titan-design/agent": patch
---

claude-print passes `maxTurns` to `--max-turns` instead of a fixed 1, raised to at least 2 when `outputSchema` is set, and reports `error_max_turns` as a retryable `runtime_error` (TP-371).
