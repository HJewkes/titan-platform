---
"titan-console": minor
"@titan-design/factory": patch
---

Show the ticket scorecard (TP-5446 slice S6). The console gains a `#/scorecard` page and a Score rail entry. It reads the scorecard store read-only (`TITAN_SCORECARD_STORE`, default `~/.local/share/titan-scorecard/scorecard.sqlite3`) through `scorecard.weeks`, `scorecard.tasks` and `scorecard.task`, and shows a week strip with red flags, six headline figures, seat, dispatcher and initiative tables, Shepherd phase medians, the week's tasks with a per-task drill-down, the open tasks resting on inferred labels, and the audit-set card. A figure that was not measured reads as not measured, and an inferred label carries a badge. The factory digest gains a ticket scorecard section: the first slot after a weekly close prints the closed week's red flags and six headline numbers from its frozen week file, and every other slot prints one line on the open week.
