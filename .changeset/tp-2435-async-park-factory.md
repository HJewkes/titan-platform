---
"@titan-design/factory": patch
---

Shepherd parks through the async `parkAgent` (TP-2435). `ParkPort`, the live-retry attempt and the fixer-retire park are async, so a park whose `agent-chat agent park` reads `titan-factory shepherd status` back from serve no longer blocks serve's event loop, starves lease renewal and replays `sh-park` on re-adoption.
