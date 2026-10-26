# pipeline-explainer spike fixtures

A second, hold-out fixture for the pace layer (`src/pace-items.ts`, `src/spike-script.ts`) beside
`redesign-explainer-v4`. It is the v1 pipeline explainer, 61 beats in nine chapters. Do not edit it to make a
test pass: re-freeze from the source below and record the new hashes.

## `script.json`

The Python-emitted script (`pipeline-explainer-2026-10-13/script.json` in the explainer research folder,
sha256 `1149dcb817982628c3c820e8438f2fc64e45b8235ff6a43aa18f5a28fc4d263b`). The frozen file's sha256 is
`828d3d72769b7b31f2e341650db39af1457d510396d35c9f0a0a080160722176`.

- `schema`, `id`, `profile`, `facts_pack`, `video`, `chapters`, `beats` and the single top-level `map` are
  copied in source order, re-indented by one space.
- `facts` is dropped. So are each beat's `visual.chips` (source citations: file paths, line ranges and config
  locations) and `visual.code` (quoted source lines). The pace layer reads none of them.
- Six internal agent, seat and gate names are replaced with generic labels, everywhere they occur. The source
  names are deliberately not recorded here:

  | Fixture label | Where |
  |---|---|
  | `implementer-a` | pin on `c4-9-spawn` (an implementer agent name) |
  | `reviewer-agent` | pin on `c6-6-reviewer` (a reviewer profile name) |
  | `sent-back` | row cue on `c7-8-owner` (an owner gate name) |
  | `coordinator-a` | `video.scope` (a coordinator seat name) |
  | `coordinator-b`, `coordinator-c` | `video.non_scope` (two coordinator seat names) |

  Each replacement is a label no other beat shows: `eval pace` gives the same chapter table and rows on the
  source and on the fixture.
- Pull request numbers (`#1345`, `#1420` and others) are left in; they point at this repository.

Its map_states name no map: node labels come from the top-level `map.nodes`. It still fails the strict
`ScriptSchema`, which is why `readSpikeScript` reads it.

## `labels.json`

A `labels/v1` set frozen from the first `explainer eval pace --format spike` run over `script.json` at planned
lengths (TP-3527): Q-E7 fails on `c5-1-contract` and `c6-10-rule`, and Q-E8, Q-E9 and Q-E10 flag nothing.
These are the checks' own flags, not judged labels, and no owner review names a beat of this video, so
`owner_named` is empty. Calibration (TP-2986) may add judged labels; record the change here when it does.

## `spine.md`

A hand-written story spine (script-method template, `spine/v1`) for this script. Its §8 keeps the script's real
chapter order, so ch2 (the architecture map) comes before ch3 (the first journey chapter) and Q-E15 fails on
ch2. Its invariants are seated, so Q-E18 passes. Do not reorder §8 to make a test pass.
