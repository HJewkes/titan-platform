---
"@titan-design/active-work": minor
---

Run precedent extract on the daemon: one pass shortly after start, then every `AW_PRECEDENT_EXTRACT_MS` (default 30 minutes, 0 turns it off), so served decisions stay current (TP-6218).
