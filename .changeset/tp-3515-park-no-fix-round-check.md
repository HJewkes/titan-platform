---
"@titan-design/agent-dispatch": minor
"@titan-design/factory": patch
---

`parkAgent(bin, name, timeoutMs, options?)` now requires its timeout, so no park call waits on the broker unbounded; pass `DEFAULT_PARK_TIMEOUT_MS` for the old default. `buildParkArgs` and `parkAgent` take an opt-in `{ noFixRoundCheck: true }`, sent as `--no-fix-round-check` (TP-3515, CC-1470); a caller that leaves it out sends the same argv as before. Shepherd's park step opts in, since agent-chat would otherwise call back into Shepherd to ask about a fix round; it needs an agent-chat CLI that knows the flag.
