---
"@titan-design/factory": minor
---

Shepherd watches main CI after every merge, its own or a seat's: serve reads each seat repo's main every 5 minutes, stays silent on green, and sends one red event per sha (failing jobs and sha) to the owning seat, with the hub seat as the fallback. A ledger beside the factory database keeps the event single across restarts.
