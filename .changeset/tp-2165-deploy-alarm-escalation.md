---
"@titan-design/factory": minor
---

A standing deploy alarm no longer goes unheard. serve logs a warning at start, and `service check` fails with `no hub seat`, when `shepherd.hubSeat` is not set. The hub seat is told again every `shepherd.deployAlarm.renotifyTicks` deploy-watch ticks (default 6) while the alarm stays up, and once it has stood for `shepherd.deployAlarm.escalateAfterMinutes` (default 30) serve files one owner-queue item into the titan console's deposit spool.
