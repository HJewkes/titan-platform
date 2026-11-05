---
"@titan-design/agent": minor
"@titan-design/agent-protocol": patch
---

A Claude adapter run that reaches its native `maxTurns` now fails as `limit_exceeded` (unit `agent_iterations`), and a Codex CLI refused by the version or capability check before spawn fails as `harness_mismatch`. Both used to be `runtime_error`, which the durable dispatcher parks in `recovery_required`; they now persist as terminal `failed`. `runtime_error` stays reserved for ambiguous transport loss, and `HarnessRunFailure` documents which kinds the dispatcher treats as ambiguous.
