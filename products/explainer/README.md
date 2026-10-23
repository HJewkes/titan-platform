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
unchanged. Every cue must be a word the beat speaks. The optional profile fields (`visual.layer`,
`framing`, `anchors`, `scene`, a cue's `untilCue`, the script's `structure` and `signature_layer`)
leave a legacy script parsing; `script-load.ts` (`parseScript`) also rejects a `structure` the
registry lacks. `deriveEvalView` computes the view the
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

`doctrine/visual-router.json` is a pinned copy of titan-design's visual router (the react-ui
`visual-router` subpath): its semantic patterns, its type catalogue with build status, and
`routeVisual`'s answer for each type. `scripts/pin-visual-router.mjs <router module> <commit>`
rewrites it; the strict schema in `visual-router.ts` fails on any upstream field it does not know.
The plan stage's slice carries the routing table in `routing`. A storyboard beat's optional `kind`
names a router type, and its packet then carries that type's card in `visual`: status, what renders
it, the closest built type and a warning when it is a gap, and its not-this list. The
`visual:gap-kind` L0 lint warns, never fails, on a script beat whose `kind` is a gap type.

Q-V10 (`heteronymCheck`) runs `@titan-design/speech-vet`'s heteronym table over each beat's
`spoken`: every occurrence needs a `[w](=reading)` declaration naming one of the table's readings,
or a `[w](/phonemes/)` override. No G2P runs here, so a declared reading is trusted, not verified.

`explainer eval l0 <script.json> --config <id> [--rules <registry>] [--bench <dir>]
[--layout <layout.json>] [--timing <words.json>] [--parent <sha>] [--fail-on-ghosts] [--speech-vet]` runs the deterministic L0 checks
(`L0_CHECKS`: the map, why, evidence, voice, flow, pace, heteronym and visual-kind lints; the map lints need `--layout` and are
skipped without it), freezes the script and appends its rows and run record. `--timing` takes a words.json, or a
durations-only extract, and the pace lints then read heard durations instead of `plannedS`. A rule that claims
a check id no run check emits is a ghost: each prints one warning on stderr, and
`--fail-on-ghosts` turns them into exit 1. `--speech-vet` runs speech-vet's `vet` on each sentence of 26 to 32
words before the checks, over local Kokoro and Whisper (no cost, but the first run downloads both models). Q-V9
passes such a sentence only when the verdict is `accepted`; a vet error counts as not clean. It is off by
default, and then, or when the models cannot load, those sentences keep the 25-word cap and one stderr line
says so. `doctrine/rules.yaml` holds which rules are
implemented or pending. `--rules` defaults to the shipped registry and must parse as
`rules/v1`. It exits 0 on a pass, 1 when an error-severity check fails (warnings never fail)
and 2 on bad input. L0 filters only: never rank scripts by how many checks they pass.

`eval l0 --format spike|v1` (default `v1`) reads a Python-emitted spike script.json by running it through
`migrateSpike` (`src/migrate.ts`) first, so every L0 check runs on the scripts the team writes. The migration drops
keys only the spike renderer reads, maps chip kinds onto `CHIP_KINDS`, and keeps `band`, `origin`, `render`, `maps`
and map_state `map`/`old`/`new` as the optional fields `ScriptSchema` admits. The frozen script is the file as read,
not the migrated form. More than two `video.invariants` no longer fail the parse: `Q-W6:invariant-cap` warns instead.

`explainer guide plan [--stage plan|script] [--spine <spine.md>]` (default `plan`) prints the planner guide v0 as markdown: the
intro (`doctrine/guides/planner-v0.md`), the stage's `sliceForStage` prompt rules for a `design-journey` video, and that
structure's story-spine template (`doctrine/structures/design-journey.yaml`: problem, one task's journey, architecture, constraints, item ledger, cut list,
chapter order). Code-enforced rules never appear, so the thresholds a lint checks (the cap on new items in a beat,
the digest gap) reach the planner only as L0 failures. With `--spine` (or `guidePlan`'s `spine` dep) the guide ends with the spine's rows and ledger per act (chapter). It exits 2 on an unknown stage.

`explainer rewrite <script.json> --judge <judge.json> --out <file> [--format spike|v1] [--rounds 1|2]
[--speech-vet] [--report <file>]` runs `rewriteScript` on a drafted script: it rewrites `spoken` toward the five
Q-V11 rows the planner guide alone does not move (`register:numbers`, `register:numbers-per-beat`, `register:triads`,
`register:sentence-mean`, `register:sentence-cv`), one schema-bound call per chapter a round through the judge the
config names (default 2 rounds). Each beat's rewrite passes `guardBeat` or keeps its original line: facts, cue words
and their order, new terms and markup survive, and a number that leaves `spoken` must reach `visual.labels` with its
noun ("5000 rows"), whose words then no longer count as dropped terms. Numbers compare spelled or in digits alike
("twenty-eight" and "28"), and a cue on a moved number lands on the label's noun when the line still speaks it. A beat that gains an L0 error row is reverted,
and a round that does not bring the rows closer to band is discarded. Remaining digits are spelled for the voice. It
writes the script/v1 result to `--out` (a spike input is migrated first) and the full report to `--report`, and
prints one JSON line: each target row before and after, what each round kept, rejected and reverted, the call count
and the spend. `--speech-vet` vets each 26-32 word sentence of the input and of every reply with local Kokoro and
Whisper, so the pass may keep it under Q-V9's vetted cap; it is off by default, which keeps the 25-word cap. Exit 0
when the result is written and every target row passes, 1 when it is written but a target row is still red, 2 on
usage or an input or judge config that does not parse. Run `explainer eval smoke --judge <judge.json>` first.

`explainer rewrite measure <script.json...> --judge <judge.json> --out-dir <dir> [--samples 3] [--format spike|v1]
[--rounds 1|2] [--speech-vet] [--max-usd <usd>] [--report-only <input:row>]` measures the pass over model noise: one
run cannot tell a 1σ gain from a lucky draw. It runs the pass `--samples` times on each input, sample by sample, and
scores each output with L0 as `eval l0` does (under `--speech-vet`, Q-V9 reads the vetter's verdicts). Under `<dir>/<input>/` it writes `before.l0.json` and, per sample, `s<k>.rewrite.json`,
`s<k>.report.json` and `s<k>.l0.json`. `summarizeMeasure` then reports, per input and target row, the mean, the sample
sd and n, whether the mean is in band and closer to it than before, and whether it is decided: further from the band
edge than its one-sided 90% t interval. Per row it reports the mean over inputs, σ (one sample's sd pooled over the
inputs) and the verdict under the revised done-when: every input closer, and the mean over inputs in band or within
1σ of it. A `--report-only` cell still counts toward its row's mean, but its input need not move closer. Results go to
`<dir>/measure.json` and `<dir>/table.md`. Each run prints one JSON line with its spend and the running total, and a
last line gives the verdict. `--max-usd` stops before a run whose cost, estimated as the dearest run so far, would take
the total past the cap. A run already in `<dir>` is reused and its spend counted (its L0 is re-scored, at no cost), so a stopped measure can be resumed.
Exit 0 when every run finished and the done-when holds, 1 otherwise, 2 on usage.

### `explainer run`: one video end to end

`explainer run [--spine <spine.md> --facts <facts.md>] [--from <stage>] [--to <stage>] [--base <runId>]
[--pin <name=sha>]... [--variant <stage=file>]... [--sample <stage=k>]... [--video <id>] [--budget-usd 20]
[--script-model sonnet] [--judge <judge.json>] [--rounds 1|2] [--data-dir <dir>]` makes one video as an
`explainer-video` run on `@titan-design/workflow` (`src/workflow/`, the corpus-query host pattern). The data dir
(default: the per-user data dir) holds `state.sqlite3`, the content-addressed artifact store `artifacts/<sha256>`
(a directory is stored as a tree of file shas), one `runs/<runId>/` directory per run, and the bridge host file
`bridge.json`. Each stage is one code step of the parent, in this order; every stage but `export` runs as its own
`explainer.<stage>` child workflow behind the stage cache (below):

| Stage | Path | Inputs → outputs |
|---|---|---|
| `script` | in-process: one `claude -p` call from the spine, the facts and the `guide plan --stage script` text, parsed with `ScriptSchema`; one retry names the schema issues, then up to two repair calls name the failing error-severity L0 rows (a repair is kept only when it fails fewer) | spine, facts → draft |
| `rewrite` | in-process `rewriteScript`; its usage is the rewrite report's own sum over calls | draft → script, rewrite-report |
| `eval` | in-process L0 (with the spine lints) and pace as gates, then the reported-only cold-viewer rubric | script, spine → l0 |
| `tts`, `render`, `qa`, `sheets` | **bridged**: the argv in `bridge.json`, run in its `workdir` | as `bridge.json` declares |
| `export` | hard links the declared artifacts into the theater folder; the run ends here | mp4 and sidecars → the same shas |

The bridge is temporary: it runs today's template commands, Python included, from a host file kept outside the repo,
so none of them ships here. Each stage leaves the bridge as its TypeScript port lands. `bridge.json`
(`explainer-bridge/v1`) maps each bridged stage to `inputs` (artifact name → path under the workdir, written before
the commands run), `outputs` (name → path, `tree: true` for a directory) and `commands` (`argv`, optional `cwd`,
`env`, `timeoutS`, `check`, which records the command's verdict, and `gate`, `true` by default; a `check` command
with `gate: false` is reported only, so its non-zero exit records a failed verdict and the commands after it still
run), plus `vars`, the defaults for `{var.<name>}`
tokens a stage variant may set. `{workdir}`, `{in.<name>}` and `{out.<name>}` expand to absolute paths. `theater`
names the folder, the file stem and the suffix per artifact for `export`. A bridged stage's `inputs` are also its
cache key: declare every artifact its commands read (the MP4 for `qa` and `sheets`), or a new render will hit an old
QA entry.

**Checks as stage steps.** Each `explainer.<stage>` child run is two code steps: the body, then `checks:<stage>`,
which runs the stage's deterministic checks from the workflow plan's §5.1 over its input and output artifacts. Every
verdict carries `gate`: a failed gate check fails the stage (and the run) and its record, verdicts included, lands in
`failed/<stage>.json`; a reported check only shows in the report. A check whose artifact the stage did not produce is
skipped with a note.

| Stage | Gate | Reported |
|---|---|---|
| `script` | `script-schema`; `l0` (error-severity L0 rows on the draft, spine lints included); `pace` (error-severity pace rows) | `l0-warnings` (warning rows, ghosts among them); `l0-repair` |
| `rewrite` | `no-new-l0-error` (an error row that passed on the draft and fails on the rewrite) | `rewrite-rows` (the Q-V11 target rows: warning-severity, and noisy run to run per TP-3878) |
| `eval` | `l0`, `pace` on the final script, checked in the body before the rubric spends | the cold-viewer rubric J8 to J12, as a note and an artifact |
| `tts` | `cue-resolution`: every cue word of the script is a word `words` says was voiced | — |
| `render`, `qa`, `sheets` | the `check` commands of the host's `bridge.json` block (for example the render cue gate and `qa`) | `check` commands with `gate: false` |

The §5.1 checks not listed are not built yet: S5c fact selection (TP-2634), cue drift, `unknownWords: "fail"`,
speech-vet and the rate band (with the TTS port, TP-2615 and TP-3004), duration agreement and two-run determinism
(TP-2992), the QA sweep gates (TP-2610, TP-2669, TP-2998), and the variety lints (PP-9). Each becomes a row of
`STAGE_CHECKS` in `src/workflow/stage-checks.ts`, or a `check` command while its stage is bridged. The judges stay
reported only until the owner labels about 20 items to calibrate them (owner answer Q6 A).

The checks are also the `products/evals/units/explainer-*` suites. Scoring them over cases into a scorecard waits on
TP-690; until then `explainer stage <name> --json` prints a stage's record with its verdicts, even when a gate failed
(exit 1), which is what a check engine reads.

**Stage cache.** A stage's key is `sha(stage, definition version, config, the input shas it reads, sample)`. The
config is the run's settings for that stage (script model; judge and rounds; for a bridged stage its whole
`bridge.json` block and `vars`) with the stage variant's params laid over them. Outputs are never keyed: Kokoro TTS
does not reproduce its audio byte for byte, so a stage downstream of TTS keys on the shas TTS actually wrote. The
`explainer_stage_runs` table in `state.sqlite3` maps a key to its child run, status and outputs. A finished key
returns its outputs at no cost (status `cached` in the report). A key whose child is still running, here or orphaned
by a crash, is adopted rather than started twice; the row is committed with the child's run row. A failed key starts
a fresh child.

A variant file (`explainer.variant/v1`: `stage`, `name`, `params`) sets `model` for `script`, `model` and `rounds`
for `rewrite`, and any declared `vars` for a bridged stage; `--variant render=w8.json` reruns render and whatever
reads its outputs. `--sample stage=k` puts sample index `k` in that stage's key, so n samples are n cached runs.
`--to <stage>` stops after it (such a run never reaches the theater). `--pin name=sha` lays a stored artifact over
the base run's; with pins and no `--base`, `--from` starts mid-pipeline from the pins alone.

`explainer stage <name> --in <name=sha>... [--variant <file>] [--sample k] [--json] [--data-dir <dir>]` runs one
stage from stored artifacts through the same cache, with no parent run, and prints whether it hit, its child run,
key, spend, output shas and check verdicts. Exit 0 when it finished, 1 when it failed, 2 on usage.

Every stage record holds its own `startedAt`, `endedAt`, usage (usd, tokens in, out and cache read, calls), retries,
checks and output shas. `--from <stage>` reuses the base run's records for the stages before it at no cost. A run
with a base belongs to the base run's video (`--video` names one outright); a run ends when the MP4 reaches the
theater, and a follow-up run from stored artifacts joins the same video. A stage with no input fails at once, naming the missing artifact. `--budget-usd` is a high
runaway backstop: once model spend reaches it, the run stops before the next stage, writes `stop.json` naming that
stage, and fails. `explainer run resume <runId> [--budget-usd <usd>]` drives a crashed run on, or starts a run linked
to a stopped or failed one from the stage it did not finish. `explainer run report <runId> [--json]` writes
`run-report.md` and `run-report.json` into the run directory: per stage the wall time and its share, usd and its share,
tokens, calls, retries, whether it was reused (a cache hit), check counts (pass, gate fail, reported fail) and
output shas, with each bridged stage marked, a "Checks" table with every verdict, its role and its detail, and every other run of the same video with its spend and the video total. `--compare <runId>` adds, per
stage, the spend and wall time delta, the stages the run took from a cache, and the output names whose sha changed.
`run` writes the report itself when it ends. Exit 0 on a completed run, 1 on
a stopped or failed one, 2 on usage.

`explainer eval pace <script.json> [--format spike|v1] [--timing <words.json>] [--config <id>]
[--rules <registry>] [--bench <dir>] [--parent <sha>]` runs only the pace lints (`paceCheck`'s
Q-E7, Q-E8, Q-E9 and Q-E10, plan ids M1, M2, M4 and M7, plus Q-E11 to Q-E14 for M5, M9 and M3). Q-E11 is an
error: a beat that states an invariant (an `inv:` cue, or a `video.invariants` phrase in its spoken
text) needs a map and may state only one. Q-E12 (a finding with no map beside it) and Q-E14 (a beat
that names items without glossing them) only route beats to the L1 judges and never gate. Q-E13
names reused `origin: v2` beats that fail Q-E7, Q-E8, Q-E9 or Q-E11, and the command then prints
`beat`, `checks` and `revoice_s`, the heard seconds to re-voice each; a v1 script has no `origin`, so
Q-E13 passes it. The other L0 checks read script/v1 fields
a spike script lacks, so they would pass one without checking anything. `--format spike`, the
default, reads a Python-emitted spike script.json loosely and notes on stderr the keys it skipped.
`--format v1` parses strict script/v1. The command freezes the script, appends eight
`structure.tsv` rows and an `L0-pace` run record under `--config` (by default `unconfigured`), and
prints one line a chapter: new items, heard (or planned) seconds, items a minute and the M7 verdict.
An item is anything new on screen, so a chip cue counts too. On the v4 fixture with its
durations, ch2 shows 20 items over 39.1 s, 30.7 a minute. On the pipeline-explainer hold-out
(`fixtures/spike/pipeline-explainer/`, planned lengths) Q-E7 fails on `c5-1-contract` and
`c6-10-rule`, and ch2 shows 13 items over 72 s. Exit codes are the same as `eval l0`:
1 only when an error row (Q-E7 or Q-E11) fails. A warning row is recorded as failing but never changes
the exit code.

A story spine (`spine/v1`, `parseSpine` in `src/spine-schema.ts`) is the planner's `spine.md`, read
from its numbered tables: §3 journey, §4 architecture, §5 constraints, §6 item ledger and, optionally,
§8 chapter order and §9 list shapes. `runL0` takes it as its fifth argument and `ledgerCheck` reads its ledger.
Q-E16 (M6) errors on a list beat whose cue entries, three or more of them (`ODD_ONE_OUT_MIN_ITEMS`), carry more
than one declared kind. A beat §9 declares `contrast` (a removal card's old/new/why, or a split map's old and new
pins) is never compared, and neither the kind-honest nor the blind odd-one-out judge question is asked about it;
an undeclared beat is `parallel`. Q-E17 errors on a beat
that shows a new item the ledger lacks, or first shows an item whose defining beat comes later in
script order. A script whose profile is in `SPINE_PROFILES` (`design-explainer`) fails Q-E17 without a
spine; any other profile passes both rows when it has none.

`spineCheck` (`src/lint-spine.ts`) adds two error rows, and only when a spine is supplied. Q-E15 runs
only for a script whose `structure` is `design-journey` or that names none, as a legacy script does. Q-E15 (FB1)
fails a chapter whose §8 row cites a §4 architecture row before the first chapter that cites a §3
journey row, and a journey step whose "why" is empty; chapters are ordered by position in §8, never by
id. Q-E18 (FB6) fails an invariant (a §3 invariant column or `video.invariants`) that no §4 row states a
mechanism for and that has no "breaks today" fact id. `explainer eval l0 <script> --spine <spine.md>`
reads the spine for all of these; without `--spine`, or for Q-E15 under another structure, a rule claiming the
skipped check is not a ghost.

`explainer eval calibrate <rows...> --labels <labels.json> [--script-sha <sha>] [--format
table|json]` scores check rows against a `labels/v1` labelled set
(`fixtures/spike/redesign-explainer-v4/labels.json` for v4, `fixtures/spike/pipeline-explainer/labels.json`
for the hold-out, whose owner-named set is empty). Rows come from a `structure.tsv`
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
  <n>] [--labels <labels.json>]` is the cold-viewer probe for Q-E6 (eval id `L1-cold`, rubric
  `rubrics/l1-cold.md`). It reads a script the way `eval pace` does, then streams it to a fresh
  viewer one chapter at a time: the chapter as heard (spoken words and each beat's end, never the
  screen) plus the viewer's own summary of earlier chapters, three lines at most.
  Questions come from the item track: what and why for every new item, what keeps every
  invariant, the odd one out for every list of three or more, and one made-up `relay-xxxxxx`
  item per call that the viewer must decline. Spoken terms (the glossary, identifiers, and the
  terms two of three fresh viewers name as undefined) are asked "what does X mean here?" in a
  second call per chapter under `rubrics/l1-cold-spoken.md`, where a sentence that only uses the
  word does not define it. An answer scores 2 for what and why, 1 for
  what only, and 0 when not stated or when a quote is not in that chapter's spoken words.
  `--labels` adds each run's reader-gap group scores (`readerGapScores`) to its line. Zeros on
  viewer-named terms (kind `viewer-term`) are counted in `undefined_terms` and
  `undefined_terms_per_minute`, apart from `undefined_items`, so the chapter bars keep their meaning.
  `--runs` defaults to 3. Each run appends `cold-scores.tsv` (one row a question, odd-one-out
  picks included), `cold-chapters.tsv` (undefined items and undefined items a chapter
  minute), `canaries.tsv` and a run record, and prints one line with its eval_version and
  undefined items a minute per chapter. A last line lists the odd-one-out picks at least two
  runs agree on.
- `explainer eval items <script.json> --judge <judge.json> [--format spike|v1] [--timing
  <words.json>] [--config <id>] [--rules <registry>] [--bench <dir>] [--parent <sha>] [--runs
  <n>] [--spine <spine.md>]` is the L1 item judge (eval id `L1-items`, rubric `rubrics/l1-items.md`). Its questions
  come only from route lists: "is X explained?" for each item `explainRoutes` (M3-pre) names,
  "is it seated?" for each `seatRoutes` (M5) beat, and the odd one out for each beat listing
  three or more items. A PROMISE beat's items are not asked "explained?": they are paid off in later
  chapters, which a chapter-scoped judge never sees. A CAVEAT beat's items are asked "is it said why
  the picture holds without X?" instead, since a simplification names what it leaves out on purpose.
  A cast line, where every item's own clause names a person ("a reviewer, a coordinator seat, and
  you"), is not asked: it introduces people, not things to explain. A beat with open questions and a
  `default:` answer label after them asks each question only what it puts to the owner, and never
  asks the answer label.
  The blind odd one out judges from the chapter alone, so it cannot see a kind the chapter never
  states: on v4's r2-1 the beat calls all seven items "jobs" and glosses none, and the judge picks
  none. The spine's declared kinds (`--spine`) are the check for that. One call per chapter that
  has a question; chapters with none are skipped. Each call plants a name-only canary beat whose made-up name the judge must call not
  explained. An "explained" yes must quote spoken words; other verdicts may quote the screen.
  `--runs` defaults to 3. Each run appends `items-scores.tsv`, `canaries.tsv` and a run record;
  a last line lists the flags at least two runs agree on.
  `--spine <spine.md>` makes the judge read the story spine (with `rubrics/l1-items-spine.md`
  added to its rubric): a list beat whose every item the ledger declares is asked "which item is
  not the kind it is declared to be?" (`kind-honest`) in place of the blind odd one out, and an
  invariant seat is asked about the §4 part that keeps it. An invariant seat that matches no §3
  invariant, or no §4 part whose mechanism keeps it, fails with no model call, and a chapter of
  only such seats makes no call and has no canary row. Spine runs get their own eval_version; runs
  without `--spine` keep theirs.
- `explainer eval smoke --judge <judge.json>` makes one tiny call through the configured
  judge, and skips a codex judge whose binary or cached login is missing, saying which.

Every verdict and answer must quote the beat it cites, verbatim and at least two words long.
A verdict with no quote, or a quote not in that beat's text on that track, is void (L1) or
scores 0 (L2, cold). Every beat call ends with one known-bad canary beat, and every viewer call
asks about a component that does not exist. A run whose judge passes a canary, or whose call
fails, is untrusted: its rows are still written, and the command exits 1.
