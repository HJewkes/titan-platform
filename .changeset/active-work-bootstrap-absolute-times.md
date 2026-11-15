---
'@titan-design/active-work': minor
---

The bootstrap prompt renders absolute ISO dates and timestamps instead of relative ages (TP-6322). The Last session heading, the Context line, the paused-since line, sibling session lines and open-loop lines no longer say "2 days ago", "12m ago" or "[1d]", so the prompt stays byte-identical as the clock moves. `time_since_last_session_human` stays in the metadata.
