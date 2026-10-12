---
"@titan-design/agent-dispatch": minor
---

`parkAgent` is now async and returns `Promise<ParkResult>`: it runs `agent-chat agent park` through `runAgentChatAsync`, so the caller's event loop stays free while the broker works. Callers must `await` it; a refusal or an unreachable broker now rejects rather than throws.
