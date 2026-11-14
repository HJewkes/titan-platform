---
"titan-console": patch
---

The decision log reads `withheld_from_agents` from the active-work inventory instead of combining the charter's human-only flag itself. A row without the field, a slug the inventory never listed, and a down daemon all keep the answer out of `answers.jsonl` (TP-5556).
