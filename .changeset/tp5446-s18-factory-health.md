---
"@titan-design/session-analytics": minor
"@titan-design/session-miner": patch
"@titan-design/factory": patch
"titan-console": patch
---

Add a "Factory health" group to the ticket scorecard (TP-5446 S18). `factoryHealthWeeks` computes, per ISO week, tasks filed by agents per task closed and per merged PR (recorded `source` or `filed_by`, else the inferred source label, marked inferred), spawn refusals and gate holds per 100 dispatched tasks, merge rate and mean fix rounds per dispatch model, and each seat's timer, event and typed wakes. Guard denials, the factory-to-product code size and the share of timer wakes with no action have no source yet and read as not measured. The store gains a `factory_health_week` table (migration 3) with `readFactoryHealth` and `upsertFactoryHealth`. The scorecard job stores the group, freezes it into each closed week's file (a week frozen before the group is not drift) and prints the last two weeks on `run`. The digest's weekly slot prints it as one line, and the console's scorecard page shows it as one more section.
