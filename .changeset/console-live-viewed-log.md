---
"titan-console": patch
---

`rounds.submit` takes an optional `liveViewed`: the round's variant keys whose live story rendered on the owner's page, deduped, bounded at 200, and refused when one is no frame of the round. Once feedback.json is written, the decision log appends one line to `$TITAN_CONSOLE_STATE/live-viewed.jsonl` with the keys and the round's Storybook build id (null when it carries none), so an audit can tell an approval made from the PNG from one made after live exploration. feedback.json and its strict schema are unchanged, and no carry rule reads the line. The round page tracks the rendered keys and sends them with its submit (TP-3793 S7).
