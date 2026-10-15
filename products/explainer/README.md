# @titan-design/explainer

Explainer video pipeline: beats.json and digest.json schemas, packet builder, finding attribution

Tier product of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Private, never published. Most of it is pure code: file schemas and the helpers the build
and repair steps share. The repo-explainer preset's gather step reads a finished repo review
from disk; plan, audio, assembly and render land in later slices.

| File | Contract |
|---|---|
| `beats.json` | `StoryboardSchema`: `video_type`, `title`, `chapters`, `beats` |
| `digest.json` | `DigestSchema`: a `since`/`until` window of items with stable ids |
| `lexicon.json` | `LexiconSchema`: written term to spoken form |
| `review-bundle.json` | `ReviewBundleSchema` (`review-bundle/v1`): repo pin, label, coverage, licenses, per-file sha256, fact counts |
| `facts.jsonl` | `ExplainerFactSchema`: one fact per line, with its source, kind, evidence spans, verified level and license safety |

`gatherReview` (`src/presets/repo-explainer/`) reads a repo review's README, SUMMARY,
`licenses.tsv`, ledger, `synthesis/final/` TSVs and digests into a bundle and its facts,
including the tour kinds (what-it-is, entry-point, read-first, should-not, integration-rec,
capability). It checks every precondition before deciding, and refuses with all the coded
diagnostics it found (`E-LABEL`, `E-UNREAD`, `E-PIN`, `E-CLONE`, `E-TOPICS`, `E-COLUMNS`, and
the rest in `GATHER_CODES`) instead of throwing. A `repo-argument` gather with no pain fact
warns `W-NO-PAIN`. `fixtures/review-whiteboard/` is a trimmed real review the tests gather.

`video_type` and each beat's `type` are open kebab-case strings on purpose. The doctrine
registry under `products/explainer/doctrine/` now names the allowed beats, video types and
audiences (`vocabulary.yaml`) and holds the craft rules (`craft/`). Type profiles (TP-2746) and
beat specs (TP-2867), which will validate a storyboard against them, are still pending; until
they land, any kebab-case value parses.

`beats.json` has no version field. A format change adds an optional field or a migration;
the zod shape is what validates a file.

The map track (`map-state.ts`, `map-lints.ts`, `map-timeline.ts`) parses each beat's
optional `visual.map_state`, lints it against the layout's ids, and compiles it to timed
segments. A beat without `map_state` is off the map; the next map beat resumes where the map
last was. `map-pins.ts` places each segment's pins at build time with graph-layout's
`placePills` and writes their boxes into the timeline, so the painter takes them as props.

`camera.ts` computes each beat's `camera/<beat>.json` station: a 16:9 box around the beat's
focus boxes that keeps them above the 83 % caption line.

`script-schema.ts` parses `script/v1`, a two-track script: per beat, a narration track
(`spoken`, `why`, `fact_ids`) and a visual track whose `map_state` is the map track's schema
unchanged. Every cue must be a word the beat speaks. `deriveEvalView` computes the view the
evals read (`nodes_shown`, `you_are_here`, `state_changes`), and `migrateTourV0` lifts a
spike tour to v1, writing `TODO:` for fields the spike never had.

`eval-store.ts` is the eval data layer. `scriptSha` names a script by the first 12 hex of
sha256 over its canonical JSON (keys sorted by code point, no whitespace, UTF-8), the same
bytes Python's `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)` gives,
so shas minted by the pilot's Python tooling still resolve. A bench keeps its rows under
`<bench>/evals/` (`structure.tsv`, `runs.jsonl`) and frozen scripts under
`<bench>/scripts/<script_sha>.json`, each with its `parent_sha`. Every row carries
`rules_sha`, the sha of the rule registry file it ran under.

`doctrine/rules.yaml` is the Q-rule registry (`rules/v1`): 60 script-quality rules in one id
space, each a hypothesis with a check. A rule row names the script fields it reads, the phase-1
ids it absorbed (`aliases`, each resolving to one rule), its `owner_support`, and an `l0` and/or
`judge` check that is either implemented (the L0 check ids it emits, or the rubric file citing
it) or `pending` with the slice that owns it. `loadRuleRegistry` parses it and rejects a
duplicate id or alias; `unimplementedL0Rules` lists rules whose claimed check ids no registered
check emits.

`doctrine/craft/<source>.yaml` is a second registry, kept apart from the Q-rules: the craft
doctrine (`doctrine-craft/v1`), every rule id the video-types study lists from DIRECTION and the
six craft doctrines. Each rule carries its scope (layer `U`, `U*`, `B` or `T`, plus beats, types
or audiences), its enforcement (token, lint, gate, planner, packet, base, human, ...), its pipeline
stages, and the evidence-ledger ids and grade the source gives it. `loadDoctrine` reads it with
`vocabulary.yaml` and `evidence.tsv`; `checkDoctrine` reports a missing evidence id, a grade the
cited rows do not state, a live code-checked rule that still lists a prompt enforcement, a `qrule`
check that does not resolve in `rules.yaml` or disagrees with its L0 status, and every scope
refinement. `doctrine/README.md` says how to add a rule.

Q-V10 (`heteronymCheck`) runs `@titan-design/speech-vet`'s heteronym table over each beat's
`spoken`: every occurrence needs a `[w](=reading)` declaration naming one of the table's readings,
or a `[w](/phonemes/)` override. No G2P runs here, so a declared reading is trusted, not verified.

`explainer eval l0 <script.json> --config <id> [--rules <registry>] [--bench <dir>]
[--layout <layout.json>] [--timing <words.json>] [--parent <sha>] [--fail-on-ghosts]` runs the deterministic L0 checks
(`L0_CHECKS`: the map, why, evidence, voice, flow, pace and heteronym lints; the map lints need `--layout` and are
skipped without it), freezes the script and appends its rows and run record. `--timing` takes a words.json, or a
durations-only extract, and the pace lints then read heard durations instead of `plannedS`. A rule that claims
a check id no run check emits is a ghost: each prints one warning on stderr, and
`--fail-on-ghosts` turns them into exit 1. `doctrine/rules.yaml` holds which rules are
implemented or pending. `--rules` defaults to the shipped registry and must parse as
`rules/v1`. It exits 0 on a pass, 1 when an error-severity check fails (warnings never fail)
and 2 on bad input. L0 filters only: never rank scripts by how many checks they pass.

`explainer eval pace <script.json> [--format spike|v1] [--timing <words.json>] [--config <id>]
[--rules <registry>] [--bench <dir>] [--parent <sha>]` runs only the pace lints (`paceCheck`'s
Q-E7, Q-E8, Q-E9 and Q-E10, plan ids M1, M2, M4 and M7). The other L0 checks read script/v1 fields
a spike script lacks, so they would pass one without checking anything. `--format spike`, the
default, reads a Python-emitted spike script.json loosely and notes on stderr the keys it skipped.
`--format v1` parses strict script/v1. The command freezes the script, appends four
`structure.tsv` rows and an `L0-pace` run record under `--config` (by default `unconfigured`), and
prints one line a chapter: new items, heard (or planned) seconds, items a minute and the M7 verdict.
An item is anything new on screen, so a chip cue counts too. On the v4 fixture with its
durations, ch2 shows 20 items over 39.1 s, 30.7 a minute. Exit codes are the same as `eval l0`:
1 only when an error row (Q-E7) fails. A warning row is recorded as failing but never changes
the exit code.

`explainer eval calibrate <rows...> --labels <labels.json> [--script-sha <sha>] [--format
table|json]` scores check rows against a `labels/v1` labelled set
(`fixtures/spike/redesign-explainer-v4/labels.json` for v4). Rows come from a `structure.tsv`
or a JSON array of `{check_id, severity, pass, detail_beats}` (`--script-sha` keeps JSON rows
with no `script_sha`); a labelled check (M1, M3 and so
on) scores the rows whose `check_id` is its name or one of its `check_ids` (Q-E7 for M1). It
prints precision and recall per check, and the owner-named recall: the share of owner-named
beats that fail at least one error-severity row. Borderline labels count as neither a hit nor
a false positive, a flagged beat with no label is reported as unlabelled, and a check no row
carries is "not run", not zero.

L1 and L2 are the model-judged layers. The judge is configuration, never a constant: a JSON
file names `provider` (`claude-print`, the Claude CLI's own login, or `codex`, a cached
`codex login`), `model`, and optionally `reasoning_effort`, `max_budget_usd`, `wall_time_s`
and, for codex, a host-only `executable_path`. Provider, model and effort are part of
`eval_version`, together with the rubric bytes (`rubrics/*.md`, beside `src/`) and the
canaries, questions and answer key a run used, so changing any of them starts fresh rows.

- `explainer eval l1 <script.json> --config <id> --rules <registry> --judge <judge.json>
  [--runs <n>]` judges each chapter's beats on B1–B6 (pass or fail) and the script on J1–J7
  (1–5), appending `beat-scores.tsv`, `script-scores.tsv` and `canaries.tsv`.
- `explainer eval l2 ... [--answer-key <tsv>] [--reference-graph <tsv>]` quizzes a fresh
  viewer on the spoken (S), spoken-and-screen (SV) and screen-only (V) tracks, appending
  `viewer.tsv`. Answer-key terms grade Q1, Q3–Q4 and W1–W3 (Q5 counts them); Q2 gets node
  recall and edge F1 against the reference graph. Questions with no key row stay ungraded,
  and P is recorded for the process-leak classifier.
- `explainer eval cold <script.json> --judge <judge.json> [--format spike|v1] [--timing
  <words.json>] [--config <id>] [--rules <registry>] [--bench <dir>] [--parent <sha>] [--runs
  <n>]` is the cold-viewer probe for Q-E6 (eval id `L1-cold`, rubric `rubrics/l1-cold.md`). It
  reads a script the way `eval pace` does, then streams it to a fresh viewer one chapter per
  call: the playback transcript of that chapter (spoken words, each label's exposure second,
  each beat's end) plus the viewer's own summary of earlier chapters, three lines at most.
  Questions come from the item track: what and why for every new item, what keeps every
  invariant, the odd one out for every list of three or more, and one made-up `relay-xxxxxx`
  item per chapter that the viewer must decline. An answer scores 2 for what and why, 1 for
  what only, and 0 when not stated or when a quote is not in that chapter's spoken words.
  `--runs` defaults to 3. Each run appends `cold-scores.tsv` (one row a question, odd-one-out
  picks included), `cold-chapters.tsv` (undefined items and undefined items a chapter
  minute), `canaries.tsv` and a run record, and prints one line with its eval_version and
  undefined items a minute per chapter. A last line lists the odd-one-out picks at least two
  runs agree on.
- `explainer eval smoke --judge <judge.json>` makes one tiny call through the configured
  judge, and skips a codex judge whose binary or cached login is missing, saying which.

Every verdict and answer must quote the beat it cites, verbatim and at least two words long.
A verdict with no quote, or a quote not in that beat's text on that track, is void (L1) or
scores 0 (L2, cold). Every beat call ends with one known-bad canary beat, and every viewer call
asks about a component that does not exist. A run whose judge passes a canary, or whose call
fails, is untrusted: its rows are still written, and the command exits 1.
