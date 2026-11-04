---
"@titan-design/agent-dispatch": minor
"@titan-design/factory": minor
"titan-console": minor
---

Offer a forced retire on the agent page once agent-chat's grace has passed (TP-4600). `listAgents` passes through each row's `exitedAt`. The factory's retire-agent route sends `--force` only when the roster's exit time is at least two minutes old, and its preview reports `forceStop`. The console's Retire sheet reads back the exit time and offers "Retire and discard" only when `forceStop` is null, with the same CHANGED re-check at act time.
