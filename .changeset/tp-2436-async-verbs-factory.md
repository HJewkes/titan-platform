---
"@titan-design/factory": patch
---

Shepherd's agent-chat adapters await the now-async spawn, resume, message and retire verbs, so serve no longer blocks on them, and a refused cleanup retire rejects instead of going unobserved.
