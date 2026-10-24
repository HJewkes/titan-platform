---
"@titan-design/explainer": minor
---

Add the beat-spec registry (TP-2867): `doctrine/beats/` holds one `beat-spec/v1` per vocabulary beat, including fifteen new review and briefing beats (`verdict-card`, `change-group`, `diff-map`, `finding-card`, `proof`, `frame-flow`, `replot`, `sim`, `rule-diff`, `kanban-flow`, `gantt`, `forecast`, `history-why`, `attempt`, `companion-link`). Each spec names a zod slot schema in `BEAT_SLOTS` and an emphasis contract: the slot lists a cue may target and the treatments its template may pick, with no default. `loadBeatSpecs`, `beatSpecFor` and `parseBeatSlots` reject an unknown beat or a bad slot, and `checkBeatSpecs` checks the registry against the vocabulary. The pr-overview, paper-summary, daily-overview and repo-tour profiles use the new beats, and planner guides gain a beat index.
