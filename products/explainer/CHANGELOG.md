# @titan-design/explainer

## 0.1.0

### Minor Changes

- 9f24b7f: Use the agent package's shared model-free Codex availability check, resolving the
  default CLI through PATH and validating required capabilities. codexUnavailable
  now returns a promise; CLI callers await it before starting the judge.
- 9010664: Add `placeTimelinePins`, which places each map segment's pins with graph-layout's `placePills` above the caption keep-out and writes every pin's box into the timeline, null when it has no clear spot (TP-2976).
- 60ec5f6: Add the explainer product scaffold: beats.json, digest.json and lexicon schemas, `buildPacket` and `attributeFindings` (TP-2611).
- 5af0c51: Add the repo-explainer preset surface: review-bundle/v1 and ExplainerFact schemas, gather diagnostic codes, and cite helpers (TP-2629).
- 4f1d1a4: Add the repo-explainer TSV fact parsers: topicFacts, ledgerFacts and claimFacts turn a review's topics, ledger and claims-audit TSVs into ExplainerFacts with E-COLUMNS and W-BAD-ROW diagnostics (TP-2629).
- 7759904: Add the repo-explainer SUMMARY, README entry-point and digest parsers that emit tour facts (TP-2629).
- 745d9e2: Add gatherReview: reads a finished repo review into a review-bundle/v1 and schema-checked ExplainerFacts (tour kinds included), refusing with every coded precondition diagnostic it finds (E-LABEL, E-UNREAD, E-PIN, E-CLONE, E-TOPICS, E-COLUMNS) and warning W-NO-PAIN on a repo-argument gather with no pain fact (TP-2629).
- 19efbdd: Add the craft doctrine registry (TP-2745 a): `doctrine/vocabulary.yaml`, `doctrine/evidence.tsv`, `loadDoctrine` and `checkDoctrine`, which reports missing evidence ids, grades the cited rows do not state, live code-checked rules in a prompt enforcement, unresolved `qrule` refs and scope errors.
- abc6160: Add `cameraStation` and `fitBox`: a 16:9 camera box around a beat's focus boxes that keeps them above the 83 % caption keep-out, serialised as `camera/<beat>.json` (TP-2790).
- dc1a5b9: Add the map track: `map_state` schema (optional per beat), `lintMapBeats` and `compileMapTimeline`, which resumes the map's last state when a beat re-enters it (TP-2791).
- f507146: Add the `script/v1` two-track script schema (`ScriptSchema`), `deriveEvalView`, `toMapBeats` and `migrateTourV0`, which migrates a spike tour and its render probe to v1 with `TODO:` placeholders (TP-2806).
- ea4017c: Add the eval data layer (`eval-store`, a TSV structure table and JSONL runs under the bench) and the `explainer eval l0` CLI that runs the deterministic checks over a script and records one row per rule (TP-2807).
- 3d013ac: Add the K2 history miner (`collect/history.ts`): `mineHistory` reads a local clone with git only and returns `history[]` and `decisions[]` whose why is quoted verbatim from a commit, plus `complete: false` for a shallow clone; `validateDecisions` rejects a decision whose sha is not a commit in the clone, whose what is not that commit's subject, whose why is not a quote, or whose alternative is not in the why. Git runs with a timeout, a scrubbed `GIT_*` environment and signature verification pinned off, and its log output is parsed NUL-delimited (TP-2808).
- 100c354: Add the Q-rule registry `doctrine/rules.yaml` (`rules/v1`, 55 rules with aliases, fields, check type and `owner_support`), its loader (`loadRuleRegistry`, `parseRuleRegistry`, `resolveRule`, `unimplementedL0Rules`), and make `explainer eval l0` validate the registry and default `--rules` to the shipped file (TP-2811).
- 0c9ded1: Add the L0 voice and flow lints (`voiceCheck`, `flowCheck`, rules Q-V* and Q-F*) over script beats and register them in `L0_CHECKS` (TP-2812).
- e747572: Add the L0 why, value and evidence lints (`whyCheck`, `evidenceCheck`) for Q-W1–Q-W6, Q-W8–Q-W10, Q-F3, Q-F12, Q-F13 and Q-E1–Q-E4, registered in `L0_CHECKS` (TP-2813).
- 4a0bf44: Add the L1 judge (`runL1`, with canaries) and the L2 viewer eval over versioned rubrics, plus the judge harness and CLI that run them against the eval store (TP-2814).
- 5f6d2c8: Add the owner session kit: `renderOwnerStoryboard` renders a script's narration and visual tracks side by side, `prepareOwnerSession` writes blind storyboards under a sealed key, and `recordOwnerSession` appends `owner.tsv` rows before it opens the key (TP-2815).
- fce872a: Add `toDiagramMapTimeline`, which converts the compiled map track into titan-design's `MapTimeline` keyframes. `message_in_flight` gains optional `untilCue` and `hopCues`, checked by the new `flow-hops`, `flow-replay`, `hop-fit` and `until-cue` lints (TP-2977).
- 183f513: Add the pace layer's item track: fromScriptV1 and fromSpikeScript project a script to PaceBeats (on-screen items, their role from CUE_KIND_ROLES, and which are new), readSpikeScript reads a spike script.json loosely and lists the fields it ignores, and readTiming reads heard durations from a words.json (TP-2978).
- 1f1e7fd: Add the pace lints as an L0 check: paceCheck (in L0_CHECKS) and paceRows emit Q-E7 (at most 4 new items a beat, error), Q-E8 (seconds a new item), Q-E9 (15 s between dense beats) and Q-E10 (new items a chapter minute, via chapterPace) as warnings; L0Input and runL0 take heard timing (TP-2979).
- 674684d: Add `explainer eval pace`, which runs only the pace lints on a spike script.json (`--format spike`, the default) or a strict script/v1 (`--format v1`), optionally with heard durations from `--timing`. It appends `structure.tsv` rows and an `L0-pace` run record, prints new items a minute per chapter, and exits 1 only when an error row fails. `explainer eval l0` gains `--timing` too (TP-2981).
- ca107ef: Add the streamed cold-viewer probe core: runCold plays a script to a fresh viewer one chapter per call, carrying only the viewer's three-line summary, asks questions generated from the item track (what and why of each new item, odd one out of each list beat, each invariant) plus one canary item per chapter, scores 0/1/2 against verbatim quotes from that chapter, and reports undefined items per chapter minute (TP-2983).
- a279343: Add `explainer eval cold`, the cold-viewer probe for Q-E6. It reads a spike or script/v1 file the way `eval pace` does, streams it to a fresh viewer one chapter per call through the configured judge, and runs three times by default. Each run appends `cold-scores.tsv`, `cold-chapters.tsv`, `canaries.tsv` and an `L1-cold` run record keyed by an `eval_version` that includes the judge's identity. Q-E6 is now cited by `rubrics/l1-cold.md`. A cold run's canary result now names the `relay-` item the viewer was asked about, and a label with no word timing is shown at an unknown second rather than from the beat's start (TP-2984).
- fd902e1: Add `explainer eval calibrate` and its core: LabelsSchema reads a labels/v1 labelled set (v4's ships as a fixture), and calibrate scores structure rows against it, giving precision and recall per check with borderline labels counted as neither, plus recall on the owner-named beats over error-severity rows (TP-2985).

### Patch Changes

- 0dcf56f: Add `sliceForStage` and `findPromptLeaks` (TP-2745 b). `sliceForStage` returns the craft rules one pipeline stage loads for a video type, audience and beats, and never puts a code-enforced rule in prompt, base or packet prose. `findPromptLeaks` flags prompt text that names a code-enforced doctrine rule, or a Q-rule whose L0 is implemented, by id, alias or exact text.
- 69cb18c: `mineHistory` and `validateDecisions` no longer lazily fetch from a partial clone's promisor remote: they pin `protocol.allow=never` and set `GIT_NO_LAZY_FETCH=1` and an empty `GIT_ALLOW_PROTOCOL`, so a treeless clone fails closed instead of running the transport command its own config names (TP-2871).
- 03964a9: Warn on stderr for each rule-claimed L0 check id that `eval l0` never emits, and add `--fail-on-ghosts` to exit non-zero on them.
- 19175ba: Read the pipeline-explainer spike script as a hold-out pace fixture: eleven more cue kinds, an optional `map_state.map` with labels from a single top-level `map`, and `labels/v1` sets with no owner-named beats.
- Updated dependencies [108b7f4]
- Updated dependencies [9f24b7f]
- Updated dependencies [dcc6957]
- Updated dependencies [9009fb3]
- Updated dependencies [3cc0993]
- Updated dependencies [9010664]
- Updated dependencies [4d3f8a8]
- Updated dependencies [29d00e7]
- Updated dependencies [a79cffd]
- Updated dependencies [5cd4f1b]
- Updated dependencies [abadd64]
- Updated dependencies [e1b38f5]
- Updated dependencies [8b35cfc]
- Updated dependencies [d3f133d]
- Updated dependencies [db712f5]
- Updated dependencies [255af30]
- Updated dependencies [375ef5d]
- Updated dependencies [d3fccc4]
- Updated dependencies [daf68da]
- Updated dependencies [d5adf04]
- Updated dependencies [d3d2bdb]
- Updated dependencies [d609dcb]
- Updated dependencies [73799b3]
- Updated dependencies [29ed958]
  - @titan-design/agent@0.6.0
  - @titan-design/graph-layout@0.1.0
  - @titan-design/speech-vet@0.1.0
  - @titan-design/agent-protocol@0.8.0
  - @titan-design/evidence@0.3.0
