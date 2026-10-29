---
"@titan-design/explainer": minor
---

`fillScript` (and `fillBeat`) turns each template beat of a script/v1 and its resolved row into the storyboard slot props its beat spec's schema accepts: derived slots (or a pinned slots entry), then resolver slots, then the owner's `visual.slots`. Each element gets a `<field>-<n>` id and the cue word it lands on; a chapter's later list, verdict-card or issue-pin beat continues the lead's stage. A beat its fields cannot fill draws as a recorded list fallback, and a beat whose `visual.slots` leave the spec invalid is refused in a `FillError`. `BEAT_SLOTS` gains optional `list.rows[].lane`, `chart.title`, `map.title` and `issue-pin.title`. No stage calls the fill yet.
