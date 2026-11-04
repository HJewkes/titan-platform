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
| `structure.json` | `StructureSchema` (`structure/v1`): snapshot, repo-map levels with box summaries and a focus graph, file centrality, reading order, entry points, call paths, edge sources |

`gatherReview` (`src/presets/repo-explainer/`) reads a repo review's README, SUMMARY,
`licenses.tsv`, ledger, `synthesis/final/` TSVs and digests into a bundle and its facts,
including the tour kinds (what-it-is, entry-point, read-first, should-not, integration-rec,
capability). It checks every precondition before deciding, and refuses with all the coded
diagnostics it found (`E-LABEL`, `E-UNREAD`, `E-PIN`, `E-CLONE`, `E-TOPICS`, `E-COLUMNS`, and
the rest in `GATHER_CODES`) instead of throwing. A `repo-argument` gather with no pain fact
warns `W-NO-PAIN`. Two optional files add facts: `explainer-skim.json` (the skill's
quote-checked docs skim) gives `skim` facts of kinds what-it-is, pain, actor, job, entry-point
and should-not, and `structural/graph-report.json` (codewatch `graph report --json` over a
lifetime index) gives `history` facts of kinds hotspot and silo. A review without them warns
`W-NO-SKIM` or `W-NO-HISTORY`; a report that is not lifetime or not at the pin warns
`W-HISTORY-PIN` and yields no history facts. `fixtures/review-whiteboard/` is a trimmed real
review the tests gather; its author identities are removed.

`enrichStructure` is the structure stage after gather. It opens the review's
`structural/graph.db` when that holds a snapshot at the pin (copied first, so the review stays
read-only), else indexes the clone with `@titan-design/code-graph` (`W-INDEX-PIN` when the
review db was taken at another commit). It returns a `structure/v1` and the facts with
`centrality` (rank-based, 1 for the most central file), `reading_rank`, `module` and
`shape_hints.graph`, all from `@titan-design/code-read`'s centrality lens; a cited code path
outside the index is `W-UNRESOLVED` and leaves the fact's centrality null. Call paths run from
the README entry files, then from unimported root files for a target those miss, to each P1/P2
topic's cited symbol: one search per target through code-graph's `findCallPath` over the
snapshot's edges (what `snapshotCallPath` reads). They become `MapFlow`s on the
`@titan-design/graph-layout` `emitRepoMap` levels; a target no entry reaches is
`W-NO-CALL-PATH`. Protocol edges come from code-graph's `extractProtocolEdges`; with none
declared the stage warns `W-NO-PROTOCOL` (code-graph's `no-protocol-source`) and the container
arrows read "imports only". An index that cannot be opened or built is `E-INDEX` and no
structure; an empty one is `W-NO-INDEX`. `fixtures/structure-ts/` is the synthetic repo the
tests index.

`gatherDaily` (`src/presets/daily/`) is the `daily-overview` facts adapter. For one UTC day it reads PRs opened
and merged in each `--repo` (`gh pr list`), the top-level Claude Code sessions active in the window (`session-read`;
subagent sidechains are left out), and the day's task deltas from `readTaskSnapshot`. That reader lists an
initiative's tasks read-only (`active-work task list <slug> --status all`), stores the day as a `task-snapshot/v1`
under `<data dir>/task-snapshots/`, and reports each task whose board column (done, owner-gated, blocked, or its
status) changed against the latest earlier snapshot as `opened`, `closed`, `moved` or `owner-gated`. With no earlier
snapshot it reports only what the task dates show. Every digest id comes from its source (`pr/<repo>#<n>/<change>`,
`session/<id>`, `task/<id>/<change>`), never a clock, and items are sorted by id. `fixtures/daily/` is synthetic.

`gatherArticle` (`src/presets/article/`) is the `paper-summary` profile's gather stage. It
reads an article or paper as markdown text, kept in a directory of its own because the source
is untrusted, and a list of proposed claims (from a model pass or a hand edit). It writes
`facts.jsonl` (`ArticleFactSchema`) and `rejected.json`:

- A claim or number is kept only when its quote is verbatim in the text, at most
  `QUOTE_MAX_WORDS` (25) words, and, for a number, states the value. A failing claim is kept
  in `rejected.json` with its reason.
- Each captioned figure or table (`Figure 2: ...`, `Table 1: ...`) whose data the text carries
  as a markdown table becomes a `figure/<id>` fact with its series, ready to re-plot. A figure
  held only as an image is noted `W-FIGURE-NO-DATA`; a table of text is noted `W-TABLE-TEXT`.

`paperPublishEligibility` (`src/article-checks.ts`) runs the profile's `publish.checks` over a
paper video's `beats.json` against those facts. `figures-replotted-from-data` fails any image
in a beat's slots, a `replot` whose `source.ref` is not a figure fact id or whose points are
not that figure's data, and any other beat citing a figure fact. `quotes-short` fails any
quote over the limit in the slots, the narration or the on-screen text. A check it does not
know fails the video.

Passing makes a video eligible to publish, nothing more. Publishing third-party text and
figures needs the owner's explicit ask for that one video (owner Q4 B). No code here
publishes, and eligibility never triggers a publish. `fixtures/article/demo/` is a synthetic
paper the tests gather.

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

`anchor-grid.ts` is the frame as a 6×6 grid of named anchors: columns `A` to `F` left to right,
rows `1` to `6` top to bottom, so `A1` is the top left. A script's `visual.anchors` and a
template's slots (`placeSlots`) name cells or `B2:E5` ranges; `anchorsForBox` maps a pixel box to
the cells it overlaps. `occupancy-table.ts` builds one table per settled mark, mapping each
occupied anchor to the element ids on it. The DOM's `[data-el]` boxes place template beats. A
custom layer that declares anchors adds `custom-layer` on them, and an undeclared custom layer
(or a mark with no DOM elements) falls back to the frame's pixel 6×6 ink coverage, so line art
is not read as an empty stage. `occupancy-checks.ts` measures what the PP-9 lints read
(`collisions`, `emptySpace`), and `anchorFindings` reports QA findings by beat, mark and anchor.
`writeOccupancy` writes `occupancy.json` (`occupancy/v1`) next to the render's `qa.json`.
`stage-empty-checks.ts` (`emptyStageRuns`) fails a beat whose stage rect holds no content box (decor excluded) for more than
`MAX_EMPTY_STAGE_SECONDS` (3 s) of sampled moments; the host's measure step feeds it one `StageMoment` per beat and time.
`content-fill.ts` (`contentFillFindings`) fails a beat whose settled element boxes, unioned, span less than
`MIN_CONTENT_FILL` (60 %) of the frame width: the gate for beats styled at 720p and pinned left on a 1080p stage.

`contact-sheet.ts` (`cutCells`) cuts contact-sheet stills from data the render already writes: `render.json` beat bounds,
the cue gate's measured cue times and each beat's component. A title is cut at its held end, an outro before its exit,
an additive beat (list, stat, compare) once at its settled last frame, a question swapped for rows before and after,
a code walk at its whole view and then each focus step, and a chart at each highlight. A page that publishes
`__titanMotion` marks is cut one cell per mark instead. Cells are never dropped by pixels.
`explainer sheets` (`writeContactSheets`) extracts each still through ffmpeg with a label strip under it and tiles one
`sheet-<chapter>.png` per chapter, plus `cells.json`; `--fill` also runs the content-fill gate. It replaces `sheets.sh`.

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
[--layout <layout.json>] [--timing <words.json>] [--facts <facts>] [--parent <sha>] [--fail-on-ghosts] [--speech-vet]` runs the deterministic L0 checks
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
[--script-model sonnet] [--judge <judge.json>] [--rounds 1|2] [--listener-questions] [--listener-threshold <q>]
[--data-dir <dir>]` makes one video as an
`explainer-video` run on `@titan-design/workflow` (`src/workflow/`, the corpus-query host pattern). The data dir
(default: the per-user data dir) holds `state.sqlite3`, the content-addressed artifact store `artifacts/<sha256>`
(a directory is stored as a tree of file shas), one `runs/<runId>/` directory per run, and the bridge host file
`bridge.json`. Each stage is one code step of the parent, in this order; every stage but `export` runs as its own
`explainer.<stage>` child workflow behind the stage cache (below):

| Stage | Path | Inputs → outputs |
|---|---|---|
| `gather` | in-process: the profile's gather body (`gatherDaily`, `gatherPr` or `gatherArticle`) on the run's gather request, which is the stage's key, written into its gather directory as well. A `gatherPr` gather refuses a head other than the one the gate named, and also stores `code` (`{ files }`, each changed file the head still has) for resolve's code citations. Optional: a run takes it only when it starts there, with `--from gather --facts-from <adapter>` (the type's profile, and so the audition's, by default); re-gathering the same request needs `--sample gather=<k>` | (the outside world) → facts, code |
| `audition` | in-process: the material map and the fit predicates, then one sampling call for k spines, code scores, the reported-only cold-viewer rubric per candidate, and the pick (below). Optional: a run takes it only when it starts there, with `--from audition --profile <type>` | facts → material-map, audition, and spine for a profile with `spine: { from: audition-pick }` |
| `script` | in-process: one `claude -p` call from the spine, the facts and the `guide plan --stage script` text, parsed with `ScriptSchema`; a reply whose only schema faults are keys the schema does not allow, or out-of-enum values on an optional field or an item of an optional list (a chip's `kind`), loses those keys (reported as `script-unknown-keys`) and values (one stage note each, naming the path, the bad value and the allowed ones), any other fault gets one retry naming the schema issues, an out-of-enum value with the values the schema allows, then up to two repair calls name the failing error-severity L0 rows, with what Q-F1, Q-F3, Q-F4, Q-F5, Q-F16 and Q-V10 found (a repair is kept only when it fails fewer). A long spine (more than `CHUNK_OVER_CHAPTERS` chapters or `CHUNK_OVER_BEATS` ledger beats) is drafted one chapter per call instead (below) | spine, facts → draft, and for gathered review facts companion and chapter-links (below) |
| `rewrite` | in-process `rewriteScript`; its usage is the rewrite report's own sum over calls | draft → script, rewrite-report |
| `eval` | in-process L0 (with the spine lints) and pace as gates, then the reported-only cold-viewer rubric | script, spine → l0 |
| `resolve` | in-process: the resolver tables, code citations and word budgets, then the template fill, with the emphasis-target, word-budget, slot-overrides, template-fill and chart-integrity gates (below), then one custom-layer build per `layer: "custom"` beat (below) | script (+ code, slots, layout when pinned, chapter-links when the script stage wrote them, facts, a pinned custom-layers tree) → resolved, generated-slots, custom-layers |
| `tts` | in-process: speech-tts Kokoro per beat, realigned and trued (below) | script → words, audio, voice |
| `render` | in-process, no model call: the template fill to a storyboard, `compileTimeline`, the composition page and `renderVideo` behind the pre-capture QA gate (below) | script, resolved, words, audio (+ code, slots, generated-slots when a run has them) → mp4, vtt, render-manifest, timeline, page |
| `qa` | in-process, no model call: render-qa's gate at the cue moments and the 2 Hz sweep over the served page tree in Chromium, the gate profile's verdict, the DOM probe, and ffprobe and ffmpeg for the MP4's length and frame change (below) | mp4, timeline, words, script, resolved, page (+ visual, code, slots when a run has them) → qa, qa-crops, framediff and qa-probe past 64 kB |
| `sheets` | in-process, no model call: ffprobe and ffmpeg for the poster, then the theater sidecar and the fingerprint (below) | mp4, script (+ resolved, slots, render-manifest, qa, visual when a run has them) → sidecar, poster, fingerprint |
| `export` | hard links the declared artifacts into the theater folder, and a run's companion doc as `companion.md` beside them; the run ends here | mp4, sidecars and companion → the same shas |

**Custom layers, keyed by packet** (`build/`, `workflow/layer-build.ts`, TP-2607). After the resolve body, each beat
the resolver made `layer: "custom"` gets a layer packet (`buildLayerPacket`: its narration, cues, framing, anchors,
scene, band and cited facts, under the packet byte cap). The builds run as `mapItems` items of the resolve child
workflow, keyed by `packetKey` = sha256 of the packet and the builder (`{ id, version, model, basePromptSha }`), never
by beat id alone, so a replay reuses every build whose packet is unchanged. The `custom-layers` tree holds one
`<beat>.tsx` per layer and a `layers.json` with each layer's anchors and element ids. A pinned `custom-layers` tree, or
a script with no custom beats, runs no builds. The builder is part of the resolve key, so a new base prompt rebuilds
every layer. The host's `beatWorker` builds the layers. When the host sets none, the default is the claude-print
worker (`claudePrintWorker`), as long as a `claude` binary is on this host (`CLAUDE_BIN` or `PATH`). With no worker
(`beatWorker: null`, or no binary), the custom beats are left unbuilt and noted, and the run goes on. The only worker
ids are `claude-print` and `agent-chat`; there is no fork runner. Any build that fails fails the stage.

The claude-print worker makes one tool-less `claude -p` call per packet. It uses sonnet, with
`doctrine/builders/custom-layer.md` as `--system-prompt` and the packet JSON as the prompt. The answer must match
`LayerOutputSchema` (module, anchors, element ids), with one turn and a $0.50 cap. Spend is priced from each model's
tokens at the price table, never from the reported `total_cost_usd`. A model the table lacks marks the spend unknown.
Every build then goes through the compile gate (`compileLayer`): an esbuild TSX bundle that refuses any import except
`react`, `react/jsx-runtime` and `@titan-design/react-ui/motion`. A build that fails the gate is marked
`needsRepair` with esbuild's error, and the stage fails with that error. A build that passes is stored by packet key in
a cross-run build cache (`LayerBuildCache`, `<dataDir>/layer-builds/<key>` naming the build's artifact sha). So when a
script or facts edit makes a new resolve run, a beat whose packet did not change reuses its build at no cost. The
in-run `mapItems` memo cannot do this, because it lasts only for one child run. A build that fails the gate is never
cached.

A build that fails the gate gets one repair round (`agentChatRepairer`; round caps are TP-2616's). It spawns an
agent-chat agent under the `beat-builder` profile (a config value) through `@titan-design/agent-dispatch`. The brief
goes on stdin, never in argv: the packet, the failing module and the gate's error, each fenced as data. The agent
writes `<beat>.tsx` into `runs/<run>/layer-repairs/<packet key>/`. Once the roster shows the agent exited, the module
is read back and the gate runs again. The agent's spend is priced from its own transcript, found by the roster's
session id, at the price table, so the `mapItems` budget sees a known cost at once. A transcript that is not on this
host, or an agent that is not seen to exit in time, marks the spend unknown rather than free. The repair's spend joins
the build's usage, and its session id is kept as `repairSessionId` on the build and in `layers.json`. A repair that
still fails stays `needsRepair` (its error names the repair session), keeps its spend, and is not cached. Repairs are
off unless the host passes a `layerRepairer`: no agent-chat binary on `PATH` or in `AGENT_CHAT_BIN` turns them on,
because the installed `beat-builder` profile predates its TSX variant. They turn on by default after TP-2608 ships
that profile. `BEAT_WORKERS` is the whole runner registry: `claude-print` and `agent-chat`, with no fork runner
and no resumed session.

**Custom layers on the page, and the text check** (TP-4418). The page draws a custom layer in the stage box between
empty chrome bands, the same box a stage kind fills, so the layer's `inset: 0` clears the chrome. Its anchors are
still cells of the full frame. After each commit the layer host raises any text under the page's `--beat-floor`
(40 px, qa's small-text floor) to the floor. After the compile gate and the cue check, the host's `layerTextCheck`
(`chromiumLayerTextCheck`, Chromium, $0) renders the layer alone on the composition page. It seeks to each cue
word's planned time plus 1 s and to the beat's end. At each moment it applies qa's own `small-text` and
`under-chrome` findings at qa's thresholds, and a `bad-text` rule for visible `NaN`, `undefined`, `null` or `[object`.
A layer that breaks a rule is rebuilt once, with a `rebuild` field naming each element, its text and the rule. The
rebuild's spend joins the build's. A rebuild that does not compile, drops a cue target or still breaks a rule fails
resolve with one row per beat, element and rule. `layerTextCheck: null` turns the check off; the test host does.

**Long scripts, one chapter per call** (`script-chunks.ts`). A spine past either bound drafts each chapter in its own
call. The shared sections (guide, spine, coverage, lead beats, budget, schema) go as the call's system prompt, the same
bytes on every call, which `claude -p` sends as its own cached block: the first chapter's draft writes it to the prompt
cache and each later call reads it. The prompt then holds that chapter's facts slice (`script-facts.ts`: the rows the
facts table's Beats column or the spine's Cites table places in this chapter, plus every row placed nowhere), what is
written so far (the video fields, the glossary, the names declared in `new_terms`, the beats' planned seconds and the
last beat), and that chapter's task. The whole-video round gets the whole facts pack, and L0 always reads all of it.
The first chapter writes the video fields; a later one adds only glossary entries. Each chapter gets one schema or
word-budget retry and up to `CHAPTER_REPAIR_ROUNDS` repair calls on the rules `rules.yaml` marks `scope: chapter`,
measured on the chapters so far with the unwritten ones as bare entries. A repair round shows the whole chapter but
asks back only the beats its failing rows name (`chapter-patch.ts`), keyed by beat id; they are spliced in place, ids
and order kept, and the chapter's rules run again on the spliced chapter. A reply naming any other set of beats is
rejected and retried once in the same round, never merged. A round with a row that names the chapter rather than a beat
(Q-W3, Q-W4 or Q-W6 when the chapter lacks the beat they read, Q-W10, Q-V4 on a "Chapter ..." label) asks back the
whole chapter as before. The chapters then join in the spine's order,
the ledger stamp runs, and the whole script gets one repair round (`VIDEO_REPAIR_ROUNDS`) whose reply lists only the beats
and video fields it changes. The stage's gates (`l0`, `pace`, `cues-present`, `unknown-words`, `word-budget`, `runtime`,
`template-fill`) run on the joined draft as on any other. Each chapter and the whole-video round leave a stage note with their calls,
dollars and prompt-cache tokens read and written, and the path stops itself at the run's spend cap between calls.

**Word-budget re-time (TP-4288).** A beat a few words over its cap gets the seconds its words need, at no cost
(`retimeOverBudget`, `script-budget.ts`): at most `RETIME_MAX_S` (2 s) more, never past the 20 s beat band, its
block's longest airtime or the profile's longest runtime. A block over its cap is never re-timed, and the re-timed
draft is kept only when it fails a strict subset of the plan faults it failed before. It runs on each draft reply
before the plan retry counts faults, so a draft that only needs seconds makes no retry, and once more after the last
repair round (the single call's, or the chunked path's whole-video round), which keeps any reply that fails fewer L0
rows whatever its word count. Each move is a stage note and the reported check `word-budget-retime`, as
`reflection-1 18→19 s`. Anything larger still fails the `word-budget` gate.

**Template fill on the draft (TP-4289).** The script stage runs resolve's template fill on its own draft
(`draftFillFaults`, `script-fill.ts`): the shipped router, no slots pin and no code. Beats whose slots come from run
artifacts the stage lacks (`code-walk`, `docs-vs-code`, `fix`, `companion-link`) are left to resolve. Each refused beat
is a plan fault, such as a list of 7 labels against the slot schema's 5 rows, so the plan retry names it and its hint
asks for the split: keep as many labels as the beat spec holds and move the rest to a continuation beat in the same
chapter. The chapter reader counts the same faults, every L0 repair round answers each refused beat as a
`template-fill` row, and the `template-fill` gate fails what is left. A rewrite round reverts a beat whose appended
labels make the fill refuse it, as `template-fill`.

**The companion doc (TP-4026).** When the facts are gathered review facts (`facts.jsonl` of `ExplainerFact`s), the
script stage also writes `companion` (`companion.md`, `renderCompanion`) and `chapter-links`
(`explainer.chapter-links/v1`: the doc's name and sha, and per chapter its section, `href` and the anchor of each fact
it cites). The doc holds every gathered fact, one section per repo-tour block in the tour's order, anchored by the
block id. A chapter's blocks come from its spine §8 row (`§3.n` names journey row n, whose step is the block) or, with
no row, block n for chapter n; a chapter that merges blocks links the first. The doc depends only on the facts, so the
tour and its review-digest cut over one review link the same bytes. The script stage is the first that holds both the
facts and the chapters, and later stages keep the chapter ids, so resolve can fill a `companion-link` card from the
links. A chapter that plays no tour block links the contents (`W-CHAPTER-UNMAPPED`), and a review with no SUMMARY
facts warns `W-NO-SUMMARY`; both land in the stage's notes. Resolve fills each `companion-link` beat's `slots`
(`title`, `section`, `href`) from its chapter's link, and notes a card whose chapter has none (TP-4107). Export
links `companion` as exactly `companion.md` in the theater folder, never `<stem><suffix>`, whether or not
`bridge.json` lists it, so the relative `companion.md#<anchor>` hrefs resolve beside the video.

**The tts stage (TP-2615).** Each beat's `spoken` text is voiced by speech-tts Kokoro (Kokoro-82M at fp32 over
speech-g2p misaki English, on the host's speech runtime) with `unknownWords: "fail"`, so a word with no phonemes
fails the stage before any audio is made. The voice and its rate are the run profile's voice band (`--profile`); a
tts variant may set `voice` and `rate`, and a run with no profile speaks as `af_heart` at 1. Each beat speaks at its
beat type's speech band (TP-2670): the stage reads the band from the `resolved` artifact and its words a minute from
`doctrine/speech-bands.yaml` (story 195, concept 175, code 160, takeaways 180, held 175), times the voice rate.
speech-tts `calibrateSpeed` steps Kokoro's speed until the measured articulation rate (pauses of 0.25 s or more not
counted) is within 5 wpm, as the bridge's `gen_audio.py` did, and truing reads the calibrated take. The engine's own word
times are re-timed against the script words (the port of the template's `realign.py`: number words meet digits,
hyphenated words meet their parts, and `HOMOPHONES` in `src/lexicon.ts` maps a heard spelling to the script's word;
an unmatched run shares the gap between its neighbours). A beat lasts `max(plannedS, 0.3 s lead + speech + 0.6 s
tail)`, rounded up to a whole frame at 30 fps, and its WAV starts with the lead's silence. The stage writes the
`audio` tree (`<beat>.wav`), `words.json` (`explainer.words/v1`: per beat `startS`, `durationS`, `words` and `heard`
relative to the beat start, and `absolute`, every word on the video timeline) and `voice.json` (`explainer.voice/v2`:
provider, engine build, voice, rate and where they came from, and per beat its band, target words a minute, the speed
found and the rate measured). Takes are cached per beat in `<dataDir>/tts-takes/` under
`sha(spoken, voice, words a minute, engine version)`, so a re-voiced script synthesizes only the beats whose text or band changed and
keeps the others' audio byte for byte. A host `bridge.json` that still has a `tts` block is refused: delete it, and
drop any sample builder it ran, since render draws the storyboard itself.

**The render stage (TP-2992 S3).** `runRenderStage` (`src/render/render-stage.ts`) fills the beats resolve kept with
the template fill as resolve gated it (cited `code`, the owner's `slots` pin, else the `generated-slots` layer), and
`boardFromFill` makes the storyboard: each beat's spec type and slots, its planned seconds and its script cue words.
`storyboardIds` (`src/render/beat-ids.ts`) is the one place script ids become `beat-01`, `beat-02`, ... in script
order; it renames the `words.json` beats and links each `<script id>.wav` of the `audio` tree under its new name, and
qa's lead-line set goes through it too. A custom-layer beat is never template-filled (`isCustomRow` is the one
predicate resolve's gate and render share): the board holds it by spec type with no slots, its built layer from the
`custom-layers` tree draws it, and a run with no built layer for it fails naming the beat. `compileTimeline` writes `timeline.json`; the built composition page is copied into
the `page` tree, with the render variant's style pack as `style-pack.css` (`:root { --pack-<slot>: var(--<token>); }`)
linked from its head, and served beside the timeline; `renderVideo` renders it behind the run type's gate profile
(`qa { mode: "gate", gate: loadQaGate(type) }`, or `"skip"` with `noQa`). The stage stores `mp4`, `vtt`,
`render-manifest`, `timeline` and the `page` tree it served, which is the tree qa serves again. The pre-capture gate
samples the cue moments and the 2 Hz sweep. After encode, the stage runs the qa stage's report core (`qa/qa-core.ts`)
on the MP4, the page it captured and the qa stage's inputs, with the run type's timing, then every row of
`QA_GATE_ROWS` (`qa/qa-gates.ts`, the same list the qa stage's checks read). The rows show on render's record as
`qa:<row>`. A failing gate row refuses the render and keeps `qa.json` as the failed record's `qa-report`, so render
refuses whatever the qa stage would fail (TP-4536). Render variant params:
`workers` (capture workers, `min(16, cores)` by default, part of the key since worker count is still part of a
render's identity), `twoRun` (render twice at the same worker count and report whether the MP4 bytes match, the
`two-run` check, never a gate) and `noQa` (the manifest records `qaGate: "skipped"`). The page and capture sit behind
`RenderEngine`; the composition page and Chromium are the default, and tests pass a fake. A host `bridge.json` that
still has a `render` block is refused, naming where each retired command went: `build_sample.py` (the template fill),
the spike page's `vite build` (the composition page, built once per source sha in the explainer cache) and `render.ts`
(`renderVideo`: capture, mix, `captions.vtt`, `render-manifest.json` and its QA gate). Its mid and end−1 s contact
sheet (`sheet`) is dropped until the beat-aware sheets (TP-3000), and `render-json` is now `render-manifest`.

**Stage fit (TP-4408).** A template beat in the stage box fits itself to it: `useStageFit` (`beats/stage/stageFit.ts`)
searches `--beat-fit` (beats.css) from 1 down to 0.2 on every render, and every text token shrinks with it to the 40 px
type floor qa's G8 gate enforces, never under it. A stat card reserves its settled figure's width, so the fit does
not change while the figure counts up. Content still past the box at the floor is a row (`overflow-row.ts`): the beat,
the element by slot id and class (`figures-2 beat-stat-label`), the px per side and a hint such as `shorten ... to <= 12
chars`. Before the QA gate and any capture, `renderVideo` runs the stage-fit scan (`render/stage-fit-scan.ts`): it
opens the page with `?stage-fit=report`, which records each row on `window.__stageOverflows` and draws on, seeks every
beat at 2 Hz and at its settled end, and throws one `StageOverflow` that lists every row. Outside report mode the page
still throws at the first row, so a capture never draws content under the chrome.

**The sheets stage (TP-4018).** The port of the host's `write_video_meta.py`. ffprobe reads the MP4's duration and
ffmpeg grabs a 480 px poster at `posterAtS`, 30 % in rounded to a tenth of a second. `buildSidecar` writes
`<stem>.video.json` as `titan-console/video-meta@1` (v1 fields only: `title`, `description` = `video.promise`,
`purpose`, `series`, `subject`, `take`, `status`, `posterAtS`, `poster` = `<stem>-poster.jpg`) and an `explainer`
block: the video id, every run of the video oldest first, the profile, the script sha and the fingerprint. `classify`
reads the profile first (`repo-tour`, `repo-argument` → `repo-review`; `daily-overview` → `daily`), then the script id
as the Python did; the title is the script id less its date. A sheets variant may set `take` (`v1`) and `status`
(`review`). The video and its run ids are part of the stage key, so a new linked run makes the sidecar again; `explainer
stage sheets --video <id>` lists that video's runs, and with no `--video` the child run is the video's only run.
`fingerprintOf` (`explainer.fingerprint/v1`, stored as `fingerprint`) keys each beat as
`${component}/${slots}/${anchors}`: the resolved component name (`spec:<beat spec>` with none; with no `resolved`, the
script's `visual.render`, else `job:<job>`), the slot count of the `slots` artifact (else `visual.labels`), and the
anchors (the resolver's, else the script's) expanded and sorted row by row. Its video fields are the profile, the
structure and its hook, the opening and closing beats, the chapter labels, the component, framing and function
histograms, the close type, the signature layer, the slot-masked spoken 4-gram hashes and the skeleton; `pixel` is
null until the beat-aware sheets land. The sidecar's copy carries the grams by hash only. A host `bridge.json` that
still has a `sheets` block is refused: delete it, along with its `sheets.sh` and `write_video_meta.py` commands.

**QA stage** (`src/qa/`, TP-2999 part A). `runQaStage` builds the QA timeline from the render's `timeline` artifact
(its beats and beat-local cue seconds), which it requires: a run without one is refused rather than rebuilt from
words and script. `words.json` and the script's held beats are read under the timeline's storyboard ids
(`storyboardIds` over `script` and `resolved`). It materialises the `page` tree with the timeline beside it, serves it on loopback (`serveTree`) and
opens the composition page with `?timeline=`. It samples render-qa's cue moments and its 2 Hz sweep
(`qaSampleMoments`; the variant param `sweep: false` keeps the cue moments only). With the sweep, each beat's settled
`end` moment is the sweep's, which a beat of the `outro` kind (timeline `kind`) takes 1 s before its end, ahead of its fade. At every moment it runs `inspectAt`, then
`addLateFill` over every beat but the lead-line beats (`leadLineBeats`: `qaLeadLine` in a bridged render's `visual`,
else the template fill's `qaLeadLine` hint under its storyboard id, as the spike's `examples/qa.ts` skips a verdict card) and `classify` with the gate profile's gating kinds, writes an annotated crop per held error (at most 8
per kind) as the `qa-crops` tree, reads the MP4's length through ffprobe, and writes `qa.json` (`explainer.qa/v1`:
`pass`, `profile`, `gateProfileSha`, `gate`, `timeline`, `moments`, `errorCounts`, `infoCounts`, `errors` and `info`
by beat with `kind`, `ts`, `at`, `reason`, `el`, `text` and `crop`, `mp4 { durationS, timelineS, frameS }`, `sweep`,
`framediff`, `probe`, `measured`, `timing`, `notes`). `framediff` is render-qa's `frameDiffs` share per MP4 frame and `probe` its
`probeMoments` at every sampled moment, each inline or, past 64 kB, the sha of a `framediff` or `qa-probe` artifact.
`measured` (`measuredFindings`) holds the page-measured findings: `motion-happened` (no frame changed between a beat's
first frame and its settled one), `clipped-text` and `content-fill` (under 60 % of the frame width) at the settled
moments, and `stage-empty` over every moment, each with the anchor cells of a DOM occupancy table built from the probe
when the table holds its elements, else the beat alone.
`timing` (`timing-gates.ts`, TP-2669) holds the DIRECTION timing gates, each `{ id, value, threshold, pass, warn?, beats }`,
with thresholds from the run's type profile `pacing` (optional `pictureChangeFailS` 8, `cueOnsetS` 0.3, `readingCps` 13,
`readingMinS` 1.5 default when a type leaves them out): `picture-change` (the longest gap between a beat's cut and the
cues whose frames move; warns above `pictureChangeMaxS`, fails above `pictureChangeFailS`), `static-window` (a still
picture over `staticMaxS` outside a held beat or a reading hold), `cue-onset` (each cue within `cueOnsetS` of its STT
word) and `reading-hold` (text the narration does not speak stays max(`readingMinS`, chars / `readingCps`)). TP-4325
gates three on-screen word checks too: the spike's G9 (a headline at most 10 words, a label at most 3), G10 (no
display text repeats 5 or more narration words in a row) and `words-per-frame` (at most 20 prose words on screen together
at any sampled moment of a prose beat; `code-walk`, `docs-vs-code` and `fix` beats are not counted). The spike's G1, G7, G8, G12 and G13 are reported; the
module doc says why the others are not ported. TP-4329 reports two temporal-contiguity checks
(`qa/reference-timing.ts`): `early-reveal` (no text element holding a cue's word shows more than one sentence before
that word is said) and `hold-through-reference` (a text element stays on screen until 0.5 s past the last word of its
beat's narration that names it). Both match an element to the narration by word, not by element id, so a cue that
highlights text already on screen can read as an early reveal; they stay reported until real renders calibrate them. `timing`
also carries `static_window_count` and `picture_change_gap_max`, ar target 3's metric (TP-4033).
The body never fails on a finding: its gates read `qa.json`, so a held error fails
the stage with the spike's one-line summary (`qa FAIL: 3 held errors (text-overlap 2, off-frame 1), …`) and the run
stops before sheets. The browser and ffprobe sit behind `QaEngine`; `chromiumQaEngine` is the default and tests pass
a fake. The gate profile `doctrine/qa/gate-profile.yaml` (`explainer.qa-gate-profile/v1`, `loadQaGate`) holds the
`default` gating kinds and inspector thresholds and per-type overrides (`gate` adds kinds, `info` demotes them,
`inspect` sets thresholds). Its loader refuses a kind render-qa cannot gate and a type no `types/<type>.yaml`
defines. The default gates every kind render-qa can gate, as the spike's `examples/qa.ts` did. Its hash and the
resolved policy are part of the qa key, as is the MP4, so a new render reruns QA. A host `bridge.json` that still has
a `qa` block is refused: delete it.

Every stage runs in TypeScript since TP-2992 S3 moved render off the bridge; the stage runner that ran template
commands from the host file is gone. The host file `bridge.json` (`explainer-bridge/v1`) is kept for `theater`: the
folder, the file stem and the suffix per artifact for `export`; `--theater <dir>` links into another folder instead. A
file that still has a `stages` block for a ported stage (`tts`, `render`, `qa`, `sheets`) is refused with the fix. A
type profile may name its bridge (`bridge: daily`): a run with that `--profile` reads `bridges/<name>.json` from the
per-user explainer data dir, whatever `--data-dir` says, so one host file serves every run of the type.

**Checks as stage steps.** Each `explainer.<stage>` child run is two code steps: the body, then `checks:<stage>`,
which runs the stage's deterministic checks from the workflow plan's §5.1 over its input and output artifacts. Every
verdict carries `gate`: a failed gate check fails the stage (and the run) and its record, verdicts included, lands in
`failed/<stage>.json`; a reported check only shows in the report. A check whose artifact the stage did not produce is
skipped with a note.

| Stage | Gate | Reported |
|---|---|---|
| `script` | `script-schema`; `l0` (error-severity L0 rows on the draft, spine lints and Q-E20 over the gathered facts included); `pace` (error-severity pace rows); `cues-present` (a beat whose beat spec has emphasis targets and no cue, or a chapter whose spine lead beat is on none of its beats); `unknown-words` (a spoken word of the spelled draft the voice's g2p, the doctrine lexicon included, has no phonemes for); `template-fill` (a beat resolve's template fill would refuse on the draft, code and companion beats left to resolve) | `l0-warnings` (warning rows, ghosts among them); `l0-repair`; `word-budget-retime` (the beats re-timed to fit their words); `script-unknown-keys` (keys dropped from the reply); `listener-questions` (opt-in, below) |
| `rewrite` | `no-new-l0-error` (an error row that passed on the draft and fails on the rewrite); `word-budget` (a beat or block of the rewritten script over the cap resolve holds it to; a round reverts a beat whose rewrite takes it over, as `word-budget`, and one whose appended labels make the template fill refuse it, as `template-fill`) | `rewrite-rows` (the Q-V11 target rows: warning-severity, and noisy run to run per TP-3878) |

**Listener questions (TP-4080).** `listener-questions` is the owner's exercise as a check: a fresh listener hears each
chapter of the draft once, with nothing before it, and lists every question the chapter raises and leaves
unanswered, each tagged with the sentence (`S1`, `S2`, ...) that raised it. Its verdict gives the questions and
sentences per chapter and the density (questions a sentence), and counts three flags that code, not the listener,
decides: a list spread over two or more sentences (the listener's lists, and any list a "Then ..." sentence carries
on), a term asked about, placed at the first sentence that speaks it, and fragments (the listener's, and any sentence
of three words or fewer). It calls a model, so it runs only under `--listener-questions`, on the `--judge` model, and
its spend is the script stage's. It is reported, never a gate: with no threshold it passes on any density, and
`--listener-threshold <q>` reports red a chapter above `q` questions a sentence. A cached script stage keeps the checks
it ran with; use `--sample script=<k>` to run the check on a draft already made. `explainer eval listener` runs the
same exercise on a script file.
| `eval` | `l0`, `pace` on the final script, checked in the body before the rubric spends | the cold-viewer rubric J8 to J12, as a note and an artifact |
| `tts` | `cue-resolution`: every cue word of the script is a word `words` says was voiced, and a script of no cues fails when a beat names a beat spec with emphasis targets | — |
| `render` | `duration-agreement`: the manifest's page and mix lengths agree within 1e-6 s (renderVideo refuses first; this re-asserts it over the stored manifest) | `two-run`: two renders at the same worker count gave the same MP4 bytes, when the variant sets `twoRun` |
| `qa` | `held-errors`: no finding held under the gate profile, with the per-kind summary; `mp4-duration`: the MP4 plays as long as the QA timeline, within one frame; `motion-happened`, `clipped-text`, `content-fill`: no `measured` finding of that code; `picture-change`, `static-window`, `cue-onset`, `reading-hold`: that `timing` gate passes; `headline-label-words` (G9), `narration-shared-run` (G10): that `timing` gate passes; `words-per-frame`: at most 20 words on screen at any sampled moment of a beat that is not a code beat; the WCAG 2.2 AA checks (decision 551): `narration-facts` (an on-screen number or headline name the narration never says, 1.2.5), `photosensitive-flash` (more than three general or red flashes a second, 2.3.1), `text-contrast` (text under 4.5:1, or 3:1 from 24 px, 1.4.3) and `chart-mark-contrast` (a chart mark under 3:1 on its ground, 1.4.11) | `captions-complete`, `captions-words`, `captions-lines`, `captions-cps`, `captions-onset`: captions are optional (decision 551); `stage-empty`: no stage left empty past 3 s; `picture-change-warn`: no gap past `pictureChangeMaxS`; `direction-gates`: the ported G-gates not gated above, and `early-reveal` and `hold-through-reference` |

The §5.1 checks not listed are not built yet: S5c fact selection (TP-2634), cue drift (`unknownWords: "fail"` is enforced by the tts stage itself),
speech-vet and a rate-band check over `voice.json` (TP-3004), the QA timing gates (TP-2669), and the variety lints
(PP-9). Each becomes a row of `STAGE_CHECKS` in `src/workflow/stage-checks.ts`. The judges stay
reported only until the owner labels about 20 items to calibrate them (owner answer Q6 A).

The checks are also the `products/evals/units/explainer-*` suites. Scoring them over cases into a scorecard waits on
TP-690; until then `explainer stage <name> --json` prints a stage's record with its verdicts, even when a gate failed
(exit 1), which is what a check engine reads.

**Stage cache.** A stage's key is `sha(stage, definition version, config, the input shas it reads, sample)`. The
definition version is a frozen base value plus a hash of the `stage-bumps/` files that name the stage: a change to
what a stage makes adds a bump file instead of editing a value, so parallel pull requests never race for the next
one (`stage-bumps/README.md`; CI's `stage-version:check` refuses a lowered or reused version). The
config is the run's settings for that stage (script model; judge and rounds; render's workers, switches, gate profile
and style CSS) with the stage variant's params laid over them. Outputs are never keyed: Kokoro TTS
does not reproduce its audio byte for byte, so a stage downstream of TTS keys on the shas TTS actually wrote. The
`explainer_stage_runs` table in `state.sqlite3` maps a key to its child run, status and outputs. A finished key
returns its outputs at no cost (status `cached` in the report). A key whose child is still running, here or orphaned
by a crash, is adopted rather than started twice; the row is committed with the child's run row. A failed key starts
a fresh child.

A variant file (`explainer.variant/v1`: `stage`, `name`, `params`) sets `model` for `script`, `model` and `rounds`
for `rewrite`, and `workers`, `twoRun` and `noQa` for `render`; `--variant render=w8.json` reruns render and whatever
reads its outputs. A render variant may also set `stylePack` to a pack in `doctrine/style-packs/`: the pack's
content hash joins the render key (an edit to the pack's file misses the cache), and its CSS (`--pack-<slot>:
var(--<token>);` per slot) is served with the page, so qa, which serves that page tree, reruns too. No other
stage takes a pack, so a new pack reruns render and never TTS. `--sample stage=k` puts sample index `k` in that stage's key, so n samples are n cached runs.
`--to <stage>` stops after it (such a run never reaches the theater). `--pin name=sha` lays a stored artifact over
the base run's; with pins and no `--base`, `--from` starts mid-pipeline from the pins alone.

`explainer stage <name> --in <name=sha>... [--variant <file>] [--sample k] [--profile <type>] [--json] [--data-dir <dir>]`
runs one stage from stored artifacts through the same cache, with no parent run, and prints whether it hit, its
child run, key, spend, output shas, check verdicts and notes. Exit 0 when it finished, 1 when it failed, 2 on usage.

**Material map** (`audition`, plan §A.3 step 1). `parseFacts` reads a facts pack: JSON lines of gather facts, or the
rows of every markdown table whose header has an `Id` column. A cue lexicon (`material-cues.ts`) marks each fact as
material: claims, tensions, changes, quantities, time series, mechanisms, flows and parallel items. One rule per
`vocabulary.yaml` signal (`material-signals.ts`) says whether it holds and which facts carry it; a signal no rule can
read without judgement (`elegant-idea`) is listed in `gaps`, never sent to a model. Each registered structure's fit
predicate is scored on the signals and the profile's `runtime.targetS`, with one reason per term; a predicate whose
outcome turns on a gap is `undecided`. `candidates` are the structures that fit and that the profile allows (its
fixed macro, or its heuristic rows, macros and fallback). The stage key covers the facts sha, the profile's version
and content hash, and a hash over the structure registry, so a doctrine edit is a new key; a body whose doctrine no
longer matches its key refuses. `material-map.json` holds fact ids and cue words, not the facts' text.

**Audition** (plan §A.3 steps 2 to 5). After the map, the stage builds a pool of structures and samples one spine
for each slot of it, in one call to the run's script model (`SAMPLE_CALL_USD` caps the call):
- **Pool** (`audition-pool.ts`). Every candidate, in the profile's heuristic order. When fewer than the profile's
  `audition.k` fit, allowed structures that are `undecided` top the pool up: an undecided structure is never a
  candidate on its own, only fills a slot after every fitting one, and counts each gap term as half met in its fit
  score. With **0 candidates** the profile's fixed macro (or a heuristic profile's `fallback`) leads the pool, and
  `audition.json` records `fallback` with the reason (which allowed structures did not fit, and which fit but are
  not allowed). A pool shorter than k is cycled, each repeat under the next beat system the profile binds to that
  structure, so a fixed tour samples k spines under different systems.
- **Sampling** (`audition-sample.ts`). Verbalized sampling: the call returns one spine per slot, each with a stated
  likelihood, its ABT or SCQA sentence, hook fact, block questions with fact ids and lead beat, the payoff block,
  the signature layer and its cuts. A reply that names an unknown fact, a block out of order, a beat or coverage
  item the profile does not list, or the wrong slot is retried once with its issues, then fails the stage with its
  spend recorded; nothing is adopted unscored.
- **Scores** (`audition-score.ts`), each 0 to 1. Fit: the share of the predicate's terms met. Coverage reads only
  the fact ids the hook and blocks cite, never the spine's own `covers` tags: the share of anchor facts placed (the
  pack's P1 facts, or with none marked, the facts behind the holding signals the structure's fit reads), averaged
  with the share of coverage items a cited fact evidences by cue (`COVERAGE_CUES`), over the items some fact in the
  pack evidences. A block with a `maxItems` cap in its structure (countdown: five) earns anchor credit for its first
  `maxItems` anchor facts only, and the candidate's `findings` in `audition.json` and the stage notes name the excess.
  Tension: stake by 15 %, complication by 25 %, a re-hook, payoff by 40 %. The re-hook check scales
  each block to the profile's target runtime and holds it to the profile's `reHookS` ceiling, or to the block's own
  band when the profile bands it longer: supports (60 to 120 s) and countdown (90 to 150 s) are runs of items, each
  its own re-hook. Range: distinct lead beats over blocks, until the resolver (PP-6) can say what it would draw.
  Freshness: the profile's must-vary `structure` and `signature-layer` against the series window; 1 until the PP-9
  fingerprint records the series (TP-4019). The cold-viewer rubric (J8 to J12) runs on every candidate's hook,
  signature layer and block questions and is recorded only. Only the signature layer goes on screen, so J12 (visual
  consistency) is skipped with a reason in `skipped` while a storyboard has fewer than two quotable visuals.
- **Pick.** The agent picks with no owner gate: the highest code total, ties to the higher stated likelihood, then
  the earlier slot. `audition.json` (`audition/v1`) keeps every candidate with its spine and scores, the pick, the
  runner-up and the margin, and the stage notes name the pick and the runner-up for the render notes. `pick.chapters`
  maps script chapter n to the profile block that block n of the picked spine plays (null when the profile names no
  such block), so per-block word caps can apply downstream. The stage
  stops at the storyboard: it writes no script and renders nothing. A profile that declares `spine: { from:
  audition-pick }` (pr-overview) also gets `spine`, the pick as a `spine/v1` story spine (`pickSpine`): block n is
  journey step n and chapter n, and the ledger lists each cited fact by id; a run through the script then needs no
  `--spine`. A gate check, `audition-scored`, fails the stage
  if fewer than k candidates carry code scores. The stage key adds the sampling model and the judge.

**Samples and the noise floor (TP-4034).** A model stage's output varies run to run as much as a tuning round moves
it (TP-3878), so one sample decides nothing. `script` and `rewrite` take samples; each scores its script (the draft;
for rewrite the rewritten script, with the input draft as the before) on the five Q-V11 target rows and reports
through `summarizeMeasure`: per cell the mean, sample sd and n, and per row σ, one sample's noise pooled over cases.

- `explainer stage <script|rewrite> --in ... --samples n [--sample k] [--max-usd <usd>]` runs sample indices `k` to
  `k + n - 1`, each a cached run of its own, so a repeat measure reuses what it has. A sample whose stage failed a
  gate still counts (its script exists); one that made no script is listed and left out. Exit 1 when a sample made
  no script or `--max-usd` stopped the measure.
- `explainer aa-floor --stage <s> --cases <dir|file...> [--split dev] [--samples 3] [--unit-dir <dir>] [--out <file>]`
  runs the champion against itself: arm A on sample indices 0 to n-1, arm B on n to 2n-1, over the case split
  (`products/evals/units/explainer-<stage>/cases`, `dev` by default). σ per row is pooled within each arm. With
  `--unit-dir` it writes the floor to the unit's `notes.md` (a marked section a new floor replaces) and
  `aa-floor.json`, stamped with the stage version it measured.
- `explainer ab --stage <s> --variants <a> <b> --cases <dir|file...> [--samples 3] [--floor <aa-floor.json|unit dir>]`
  runs both arms (`champion` names the run's own settings) and judges each row's B minus A: within 2σ is `noise`
  however it points; past it, `win` or `loss` when B's mean sits nearer or further from the band than A's, `shift`
  when both are equally near (both in band). σ comes from `--floor`, else from the arms' own pooled σ (`unknown`
  with one sample and no floor).

All three take the stage settings of `explainer stage` and `--max-usd`, which stops before a run the dearest run so
far says would pass it, with one cap over both arms.

Every stage record holds its own `startedAt`, `endedAt`, usage (usd, tokens in, out and cache read, calls), retries,
checks and output shas. `--from <stage>` reuses the base run's records for the stages before it at no cost. A run
with a base belongs to the base run's video (`--video` names one outright); a run ends when the MP4 reaches the
theater, and a follow-up run from stored artifacts joins the same video. A stage with no input fails at once, naming the missing artifact. `--budget-usd` is a high
runaway backstop: once model spend reaches it, the run stops before the next stage, writes `stop.json` naming that
stage, and fails. `explainer run resume <runId> [--budget-usd <usd>]` drives a crashed run on, or starts a run linked
to a stopped or failed one from the stage it did not finish. `explainer run report <runId> [--json]` writes
`run-report.md` and `run-report.json` into the run directory: per stage the wall time and its share, usd and its share,
tokens, calls, retries, whether it was reused (a cache hit), check counts (pass, gate fail, reported fail) and
output shas, with any stage a reused pre-port record says was bridged marked, a "Checks" table with every verdict, its role and its detail, and every other run of the same video with its spend and the video total. `--compare <runId>` adds, per
stage, the spend and wall time delta, the stages the run took from a cache, and the output names whose sha changed.
`--facts-from gatherDaily --type daily-overview [--day <YYYY-MM-DD>] [--repo <owner/name>]... [--transcripts <dir>]...
[--initiative <slug>]` replaces `--facts`: the adapter writes `digest.json` and `facts.md` under
`<data dir>/gather/<type>/<day>/`, and the run starts from that facts pack. `--facts-from gatherArticle --type
paper-summary --article <path> --claims <path> [--label <text>]` writes `facts.jsonl` and `rejected.json` there
instead; the article and claims are keyed by content, and a file edited after the run was planned fails the gather.
The type's profile must list the adapter in `inputs.adapters`. With `--from gather` the gather runs as the run's
first stage; from any later stage it runs before the run. `--dry-run` gathers (or, from `gather`, names the adapter),
prints the plan and stops before any stage.
`run` writes the report itself when it ends. Exit 0 on a completed run, 1 on
a stopped or failed one, 2 on usage.

### `explainer pr`: PR videos

`gatherPr` (`src/presets/pr-overview/`) is the pr-overview profile's gather stage body (`inputs.adapters:
[gatherPr]`). `explainer pr gather <owner/repo#N> --clone <dir> --out <dir>` runs it on request. It reads the PR
through two `gh pr` calls (`view --json` and `diff`), and indexes the head commit's tree with code-graph from the
clone's git objects, so the clone needs the commit (`git fetch origin pull/N/head`) but no checkout of it. It writes
`facts.jsonl` (`PrFactSchema`, sorted by kind then id) and `gather.json` (outcome and diagnostics):

| Kind | Id | Feeds |
|---|---|---|
| `pr` | `pr` | `summary`: title, linked task, head sha |
| `change` | `change:<path>` | `changes`: status, +/- counts, head-side hunk line spans |
| `finding` | `finding:<sha256(origin, body)[:12]>` | `shortcomings`: each review or comment with a body, and its `Verdict:` |
| `call` | `call:<from>-><to>` | `interactions`, the sequence slot: calls between two different changed files |

Ids come from content, never position, so two gathers of one head write the same bytes and a new comment renumbers
nothing. Refusals (`PR_GATHER_CODES`, no `facts.jsonl`): `E-PR-REF`, `E-PR-READ`, `E-EMPTY-DIFF`, `E-LINKED-TASK`
(no task id in the title, body or branch: the profile's `linked-task` precondition), `E-CALLGRAPH` (the clone cannot
index the head) and `E-NO-CLONE`. `W-NO-FINDINGS` and `W-NO-EDGES` warn and still gather.

`explainer pr trigger [--dry-run] [--clone <owner/repo=dir>]... [--port <n>] [--through audition|script] [--json] [--data-dir <dir>]` is the only
automatic path (owner answer Q6). It reads `titan-factory shepherd waiting --json` and starts a decision-brief run
only for an owner gate whose hold class is `visual-gate2`, on a head the gate still names (`autoBriefTargets`).
Every other PR, seat gates and other owner holds included, is on request only. A start writes
`<data-dir>/pr-briefs/<owner>--<repo>--<N>--<head12>/brief.json` (profile `pr-overview`, cut `decision-brief`), then
runs an `explainer-video` run from `gather` to `audition` (`briefRunStart`). `--through script` opts in to the script as well, planned on the spine the audition writes from its pick, at about $1 more a head; it is off by default while most champion scripts still fail L0 (TP-4095), so most such runs would pay to end `refused`: the gather stage writes `facts.jsonl` and
`gather.json` into the same directory, and `run.json` names the run, its status and each stage's status. A directory
that already holds `brief.json` is `already`, so a repeated sweep starts each head once. Right before each start the
sweep reads the gates again, and a head no longer current there is `moved`. `--dry-run` prints `would-start` rows and writes nothing. Nothing schedules the sweep:
run it by hand, or from whatever the owner wires. Exit 0, or 1 when a start was refused.

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

`explainer eval writing <script> [--format v1|spike|text] [--json] [--table <file>] [--bench <dir> --config <id>]`
scores a script at $0 against `doctrine/writing-check.json`, reading each row's status at the script's own length
bucket. `--format text` takes one beat per line. Rows print by dimension with value, band, human standing, status,
verdict and up to 3 offending spans. Human standing is a percentile: the share of held-out human windows at that length
at or below the script's value, read through the 5-point quantile curve in the table. `p62 n=17` adds the window count
when fewer than 20 stand behind it. The human reference is speech transcripts, not written scripts, and the header says
so. Under 150 words every row is reported only. Exit 0, 1 when a gate row fails, 2 on bad usage.
Warning and report-only rows never change the exit code, and dropped rows print no value. It writes nothing unless
`--bench` is given; then it freezes the script and appends one `writing:<row>` structure row per metric and a
`writing-check` run record, with the table's sha in the `rules_sha` column.

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

`claimsCheckWith(facts)` (`src/lint-claims.ts`) runs Q-E20 over gathered facts of any profile. It reads each beat's
spoken line, headline, labels and chips, with spelled numbers read as digits ("PD-three hundred ten" is PD-310).
A pull request (`PR 12`, `#12`, `owner/repo#12`, or a short repo such as `ac#12`) or a task id must appear in some
fact's id or fields. A count, a number with a known noun or a state ("three open PRs", "79 merged"), must equal a
value in a fact the beat cites, or the number of cited facts that carry its noun and state; a beat that cites
none reads every fact. Ordinals and durations never read as counts; `NOT_A_CLAIM` skips an index ("chapter 2
merged"), a year after "in" or "since", and a pronoun "one" ("which one merged"). Each
unbacked claim is a `claimFindings` row naming the beat, the claim and the nearest fact, and the error row fails
those beats. The registered `claimsCheck` has no facts, so it emits a passing Q-E20 warning that says the check
did not run. Every L0 call site swaps it for `claimsCheckWith` over the gathered facts (`src/claim-facts.ts`): the
script, rewrite and eval stages read the run's `facts` artifact, and `eval l0 --facts` reads a daily `digest.json`
or a facts pack. The script stage's repair hint then names the nearest fact for each unbacked claim.

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

**Judge calibration (TP-4012).** The model judges (the cold probe, the cold-viewer rubric J8 to J12, L1's beat
dimensions, and the audition's code and rubric pickers) stay reported only until the owner's labels show they agree
with the owner.

- `explainer eval calibrate queue <manifest.json> --round-dir <dir> --key <key.json> --unit <id> [--round 1]
  [--size 20] [--seed <s>] [--max-density <q>]` reads a `calibration-manifest/v1` file. For each case the file
  gives its script, the bench the judges wrote to, its video type, split and owner-named flag, `format` (`v1`, or
  `spike` for a spike-era script) and optionally `listener`, the script's `explainer eval listener` result. Its
  optional `auditions` list names `audition/v1` records, each with a case, title, video type, split and
  owner-named flag. Keep the manifest outside this repo, because it names private scripts.
- `--max-density` is the listener screen. Cold and L1 items stay only from chapters whose listener density
  (questions a sentence) is at or under it, and rubric items only from a script at or under it overall. A case
  with no listener result is refused. The overall density also orders the round: the clearest video first, then
  the pairs, then the other videos from clearest to least clear.
- Under `--max-density` the round also asks "Is this chapter clear enough to follow on one hearing?" for 3
  chapters, on top of `--size`, so no judge loses a label to them. They are the heard chapters (holdout and
  owner-named cases left out) nearest the bar, taking turns between chapters at or under it and chapters over
  it, so the answers bracket it. Each goes first in its video's section, clearest chapter first. Its key entry
  is judge `listener`, passes when the chapter clears the bar, and carries the chapter's `density`.
- The command takes the judges' unvoided rows for that exact script. It skips cold zeros that code wrote rather
  than the judge (a bare list item, an unanswered question, a failed call). Each question keeps one verdict, the
  last one written, and the key names the `configId` and `run` it came from (round-1 keys have neither, and still parse). It turns each verdict into a yes or
  no question:
  - cold probe: does the chapter answer the question the viewer was asked about an item, in that kind's own
    words (what-why, invariant or term), with a score above 0? An `inv` item gives two questions.
  - cold-viewer rubric: does the script reach the middle anchor of a dimension (3 or more)?
  - L1: does the beat pass a B dimension?
  - audition pair: the pick and runner-up storyboards, shown as A and B in a seeded order, with the sentence,
    the opening line and each block's question and length; never the structure, system, candidate id or scores.
    One owner question carries two key entries: `audition-code` prefers the pick, and `audition-rubric` the side
    with the higher J8 to J11 sum over the rows both sides scored (no entry on a tie). The key reads a pair's
    `pass` as "prefers A".
- Each key entry carries the judge's `evalVersion`; for `audition-code`, a hash of the pick rule.
- It drops holdout and owner-named cases. Judges take turns, so each gets an even share of the queue; within a
  judge, its video types and verdicts also take turns. A pair counts as `audition-code`'s turn, and pairs where
  the two pickers disagree take their own turn.
- It writes `round.json`, a questions-only console round with one section per video. A section shows the script
  as spoken, then that video's items as optional `Yes` / `No` / `Can't tell` pick-ones (`A` / `B` / `Can't tell`
  for a pair). The header gives the estimated minutes (1.25 a yes or no item, listener items included, 2 a
  pair). Section ids are `case-<slug>`, and a slug past the console's 32-character id rule keeps a prefix and ends in
  a hash of the case; `calibration-round.test.ts` checks every id against the console's `/^[A-Za-z0-9_-]{1,32}$/`. The round shows no judge name, verdict or recommendation. The verdicts go to the answer key, named `<unit>-r<round>`, which is kept
  outside the round directory. The command never overwrites an existing round or key.
- `--round-dir` is a staging directory. File the round from it with `titan-console decisions file
  <dir>/round.json --seat <seat> --initiative <initiative>`, which writes the asker and notifies the owner.
- `explainer eval calibrate agreement --key <key.json> --feedback <round>/feedback.json [--record <file>]
  [--format table|json]` reads the owner's labels from the console's `feedback.json`. For each judge it prints the
  labelled and can't-tell counts, the agreement (the share of labelled items where owner and judge agree), and the
  recall on the items the owner failed. `--record` writes the `judge-agreement/v1` record.
- Repeat `--key` and `--feedback` (paired by position, oldest round first) to pool rounds. A judge's newest round
  counts whole; an earlier round's item counts only at an `evalVersion` the newest round ran, and is otherwise
  reported as `stale`. An item with no `evalVersion` (round-1 keys) never pools into a later round. The pooled
  record lists its `rounds`, and each judge row its `eval_versions`. A round given twice is refused.
- `explainer eval calibrate listener-labels --key <key.json> --feedback <round>/feedback.json [--out <file>]`
  prints a `listener-labels/v1` record: one row per listener item the owner answered Yes or No, with its case,
  chapter, `density`, `clear` and the listener's `eval_version`. These rows are TP-4080's labelled threshold
  examples; a "Can't tell" gives no row.
- `promotionRefusal` reads that record. It refuses a judge with no recorded agreement, fewer than 5 labels, or
  agreement below 0.8. The evals units test checks that every judge check stays `reported`.

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
- `explainer eval listener <script.json> --judge <judge.json> [--format spike|v1] [--threshold <q>] [--out
  <result.json>]` runs the listener-questions exercise (eval id `L1-listener`, above) on a script file, one call a
  chapter, and prints one line: questions, sentences and density, overall and per chapter, with each chapter's
  questions per sentence and flags. `--out` writes the whole `ListenerResultSchema` result, every question with its
  sentence. It exits 1 when a chapter is above `--threshold` or a call fails.
- `explainer eval smoke --judge <judge.json>` makes one tiny call through the configured
  judge, and skips a codex judge whose binary or cached login is missing, saying which.

Every verdict and answer must quote the beat it cites, verbatim and at least two words long.
A verdict with no quote, or a quote not in that beat's text on that track, is void (L1) or
scores 0 (L2, cold). Every beat call ends with one known-bad canary beat, and every viewer call
asks about a component that does not exist. A run whose judge passes a canary, or whose call
fails, is untrusted: its rows are still written, and the command exits 1.

### Emphasis mapping and the target gate

A script beat's `visual.cues` are its emphasis cues. Each one maps a spoken span, `atCue` to `untilCue`, to
`target`: the id of one element in the beat. The optional `visual.beat` names the beat spec, and the spec's
`emphasis.targets` lists the slot lists whose item ids a cue may name. How the element is emphasised (pointer,
highlight, trace, scale, colour, camera) is the template's choice from the spec's `treatments`. This package adds no
pointer layer and no default treatment.

- `emphasisCues(beat)` lists each cue's word range and target. `targetsForSpan(beat, span, timings?)` maps a word
  range, or a time range through the beat's word timings, to the targets whose cues overlap it.
- `emphasisTargetGate({ beats, specs, slots, layout?, marks? })` is the resolve stage's gate. It fails a cue when:
  - its beat names no spec (`no-beat-spec`), or the beat's slots fail the spec (`bad-slots`);
  - the target names no element (`no-element`), or names more than one, such as a node and an edge that share an id
    (`ambiguous`);
  - once laid out, the element's box is missing or not wholly inside the frame (`off-frame`);
  - given the mark frames either side of the step, the step changes under 2 % of the target's box. A pixel counts as
    changed when a channel moves by more than 8 levels (`unchanged`; `changedShare`, `emphasisStepChanges`).
- `emphasisGateVerdict` gives the result as a stage check's `{ pass, detail }`. The `resolve` stage registers it as
  its `emphasis-target` gate (below).

Stubbed: the mark frames come from beat-aware marks (TP-3000), which are not built yet. The rule takes two decoded
RGBA frames and the target box, and its tests use synthetic frames. `fixtures/emphasis/` holds a synthetic script,
slots and layout.

### The resolve stage

`explainer.resolve` (workflow plan §2.3 stage 6, profiles plan slice 6) runs after `eval` and before `tts`. It reads
the rewritten `script` and, when a pin or an earlier stage supplies them, `code` (`{ "files": { path: text } }`, the
cited files at the video's sha), `slots` (template slots by beat id) and `layout` (element boxes). Its config pins the
beat specs, profiles, pinned router, speech bands and resolver rows by content hash, so a doctrine or table edit is a
new stage key.

- **Resolver tables** (`resolve-tables.ts`). Each beat's key is `{function, job, content, route}`: `content` is
  `code`, `map`, `items` or `statement`, read off the visual track, and `route` is the visual-router type its `kind`
  names, or `none`. `RESOLVE_ROWS` is ordered, most specific first, and the first matching row picks
  `{beat, framing, layer}`. `FRAMING_ANCHORS` gives the anchors. The beat spec gives the component and speech band. An
  authored `visual.beat`, `framing`, `layer` or `anchors` overrides the row. No row matches everything. A HOW
  beat's `code-proof` with no excerpt resolves to `proof` at the code band (TP-4093); one with an excerpt is a
  `code-walk`.
- **Refusals** (`resolve-beat.ts`, `resolve-citation.ts`) are coded and listed together in one `ResolveError`, before
  the stage stores anything:
  - `E-RESOLVE-NO-ROW`: no row matches. There is no list fallback.
  - `E-RESOLVE-JOB-UNSET`: the job is still a placeholder.
  - `E-RESOLVE-UNKNOWN-BEAT`: the beat spec is not in the registry.
  - `E-RESOLVE-STILL-MOTION`: a `cast-in-motion` beat is not on a custom layer.
  - `E-RESOLVE-CITATION`: a code beat cites a missing file, a range past the end of the file or a highlight outside
    its range, or the run has no `code` artifact. This is evidence's `verifyRange`, the quote-free half of
    `verifyCitation`.
- **Word budget** (`resolve-budget.ts`). A beat holds `floor(plannedS × rate)` words at its beat type's speech band:
  story 3.2, concept 2.8, code 2.3, takeaways 2.8 and held 1.5 words a second (TP-2670), read from
  `doctrine/speech-bands.yaml`, which also joins the resolve stage's doctrine sha. A chapter whose id names a
  profile block is also held to that block's longest airtime at the fastest rate its beat types allow. Other
  chapters are listed in a note and not capped.
- **Output** `resolved` (`explainer.resolved/v1`) gives, per beat, the key, row, beat spec, component, band, framing,
  layer and anchors, plus every budget row. Resolve also stores `generated-slots`: the template fill's `generated`
  slots by beat id (a `slots` pin's entries included), before the owner's overrides (below). A refused fill stores
  none. It is never named `slots`, which is only ever the owner's pin, so a later run that carries it forward still
  fills fresh.
- **Variety (reported, TP-4019).** `variety-top-component`, `variety-component-run`, `variety-template-share`,
  `variety-framing-run`, `variety-min-framings` and `variety-cast-in-motion` read `resolved` against the profile's
  `layers.componentMaxShare`, `layers.templateMaxShare` and `variety.minFramings`, plus a run of at most 2 components
  and 1 framing. Each detail names the beats a fix would change. None is a gate yet; cast-in-motion counts the
  `E-RESOLVE-STILL-MOTION` beats the resolver already refuses.
- **Gates.** Every gate that reads the fill reruns it with the `slots` pin, as the body did. `emphasis-target` runs
  `emphasisGateVerdict(readEmphasisInput(...))` on the beat specs the fill drew (a fallback's included), over the
  filled slots with the owner's overrides laid on; a refused fill fails it. `word-budget` fails on any beat or
  block over its cap. `slot-overrides` refuses an owner override the chosen beat spec would not accept (below).
  `template-fill` fails when `fillScript` refuses a beat, naming it; a fallback passes and is listed in the detail.
  `chart-integrity` (`chart-integrity.ts`, TP-4332) reads each filled `chart` and `replot` beat's optional `baseline`,
  `axisBreak`, `scale` and `legend` slots: it fails bars on a baseline above zero or with a broken axis (CH-11, CH-13),
  a `sequential` colour scale whose CIELAB L* is not strictly monotonic or a `diverging` one not light at one interior
  peak (CH-22), and a legend on up to `DIRECT_LABEL_MAX` (6) series, which direct labels fit (CH-20). The `chart`
  page kind draws all four (`beats/chart-frame.tsx`, TP-4337): its axis starts at `baseline` and names it when it is
  not zero, `axisBreak` draws a break mark at the origin, `scale` colours each point by value (a diverging scale
  centred on the baseline) and `legend` keys each series to its colour. `replot` has no page kind yet.
  A line chart of more than 7 points closes its column gap and gives its plot 320 px, since its labels wrap to two
  lines; a legend takes another 120 px from the plot. So a line chart of up to 12 points fits its stage box, with or
  without a legend (TP-4338).
  A bar chart of more than 9 rows packs to 44 px rows on a 6 px gap, and with a legend to 40 px rows on 4 px, so a
  bar chart of up to 12 rows fits its stage box, with or without a legend (TP-4343).
- **Owner overrides** (`slot-overrides.ts`, TP-4021). A template beat's `visual.slots` holds top-level slot fields
  that replace the generated values whole (an array is one field), and `visual.tune` holds tuning constants, carried
  untouched until page kinds declare a tune schema. `withSlotOverrides` lays them over the generated slots, so they
  win over every other layer; the emphasis gate reads slots that way. The `slot-overrides` gate fails a field the
  spec's slot schema lacks or whose value it rejects, naming the path (`beats.<id>.visual.slots.rows.0.id`), and any
  override on a custom-layer beat. A script with neither field resolves to the same bytes as before. Both fields
  are the owner's: the script stage's prompt shape (`DraftScriptSchema`) leaves them out, and a draft reply naming
  them loses them as `script-unknown-keys`.
- **Owner edits** (`slot-edit.ts`, `workflow/edit-cli.ts`, TP-4021). One save is an `explainer.slot-edit/v1`:
  `{ schema, base: { runId, scriptSha, mp4Sha }, beats: { <id>: { slots?, tune? } }, fromNote?, createdAt }`. Each
  field replaces the override whole, and `null` drops it so the generated value stands again; anything else on a beat
  is refused (spoken and framing go through rewrite and eval). `applyEdit` refuses a base whose script is not the
  edit's `scriptSha`, a beat the script lacks, a beat whose resolved layer is not `template`, an edit that changes
  nothing, and a slot change that drops an element a cue targets, naming the cue. It returns the new script, byte for
  byte the base's outside each edited `visual.slots`/`visual.tune`, and a field diff against what the render saw
  (the run's `generated-slots`, else its `slots` pin, with the overrides laid over it).
  - `explainer edit check <edit.json|->` adds `ScriptSchema` and the `slot-overrides` gate and prints
    `{ ok, editId, problems, diff }` as JSON; it writes nothing: no file under the data dir (cache, lock, ledger or artifact) is created or changed, which a test checks by snapshotting the tree. When the overrides pass, it runs TP-4134's `fillScript`
    on the edited script (the base's `slots` artifact pinned, as at resolve) and the emphasis-target gate on the filled
    slots, so a refused beat or a cue left with no element is refused here (`workflow/edit-fill.ts`).
  - `explainer edit apply <edit.json|-> [--start] [--json]` stores the script artifact (provenance
    `{ runId: "input", stage: "edit" }`) and writes `<data dir>/edits/<editId>.json` (base, video, new script sha,
    beats, `fromNote`, status `stored` or `started`, and the run id once known). `--start` launches
    `explainer run --from resolve --base <run> --pin script=<sha> --edit <editId> --budget-usd 0.25` detached, its
    output in `edits/<editId>.log`, and returns at once. The run pins the base's `custom-layers`, so a template edit
    never rebuilds a layer; its tts takes are all cached, so it voices nothing; it links its id into the ledger as it
    starts, joins the base's video, and its report says which edit it carries.
    When a systemd user manager is reachable (`$XDG_RUNTIME_DIR/systemd/private` exists and `systemd-run` runs), the run starts
    as a transient unit `explainer-run-<editId>` (`systemd-run --user --collect`, output appended to the same log), so a restart
    of the calling service does not kill it; otherwise, or if `systemd-run` refuses, it is the detached child described above
    (`workflow/edit-launch.ts`). One save makes one run: once the ledger
    row is `started`, any later `apply` of the same edit, with or without `--start`, is refused (exit 1) and leaves the
    row and its run id alone.
  - `explainer edit list --mp4-sha <sha> | --video <id> [--json]` lists the ledger rows with each linked run's
    status (`not started`, `starting` before the run links itself, then the workflow status).
  - `explainer props --mp4-sha <sha> [--json]` (`workflow/props-cli.ts`, `workflow/beat-props.ts`) is the props
    panel's read model. It finds the newest run whose export linked that mp4 (the theater file's sha256 is the run's
    `mp4` artifact sha), or prints `{ found: false }`. A found result carries `scriptSha`, the run's `script` artifact sha, which is the
    `base.scriptSha` an `explainer.slot-edit/v1` draft names. For each template beat resolve kept (cut and custom-layer beats
    are left out) it gives `id`, `chapter`, the drawn `spec` and its `slots` ref, `schema` (`z.toJSONSchema` of
    `BEAT_SLOTS[ref]`, input side), `value` (`fillScript` with the run's `slots` artifact pinned and the owner's
    overrides laid over it), `overridden` fields, `locked` ids (the ids its cues target), `startS`/`endS` from the
    `words` artifact, and `stillS`, the later of `endS - 0.3` and its last cue. `saveBack { enabled, reason }` is on:
    render is in process and draws from the fill (TP-2992 S3), so a saved edit reaches the MP4. Tune schemas join each beat when page kinds declare them (H1).

### Template fill

`fillScript(script, resolved, { specs, pinned?, code? })` (`template-fill/`, TP-4134) turns each template beat of a
`script/v1` and its `resolved` row into storyboard slot props, parsed by the beat spec's slot schema through
`parseBeatSlots`. It is pure: the caller passes the beat specs, a pinned `slots` artifact and the code source
(`codeSource(code)`). The resolve stage stores its `generated` slots as `generated-slots` and gates on the fill (above); TP-2992 S3 builds the
storyboard from it.

- **Layers.** The derived slots (or the pinned entry for the beat, which replaces them), then resolver `slots`, then
  the owner's `visual.slots` through `withSlotOverrides`, the same call the emphasis gate makes. `generated` is every
  layer under the owner's; `overridden` names the owner's fields.
- **Derivation.** `DERIVERS` holds one row per `BEAT_SLOTS` ref, so a new ref without a row fails typecheck. The rows
  port the spike sample builder's label conventions: a list row's mark is its first word (`tick`, `cross`, `risk`, `open`,
  `dot`) and `<lane> · <text>` names its lane; `name: number` labels chart as bars, or as a line when there are 3 or
  more and every name is a date; `before:` and `after:` labels pair by order into compare rows; 2 to 5 labels make a
  map path. Refs whose slots carry structure a label does not hold (gantt, schema, sim and the like) derive nothing
  and need `visual.slots` or a pin.
- **Element ids** follow the cue convention: item n of field f is `f-n`, so a script cue's `rows-2` target names it.
  Each element's cue word is the first cue whose target ends in `-n`; a missing one takes the one before it, and the
  first defaults to the first spoken word. `reveals` lists them; `hints.placeholder` is set when the first lands past
  30 % of the words. Compare numbers per label, as cues do: a row's `id` is its `before:` label's `rows-n` and its
  `alias` its `after:` label's, and an emphasis cue may name either. A list whose chapter label is longer than a
  title holds draws untitled, with `hints.titleOmitted`.
- **Continuation.** A later beat in a chapter that names the lead's `list`, `verdict-card` or `issue-pin` spec keeps
  the lead's heading and its last rows (renamed `held-n`, shown from the first word), up to 3 rows with its own.
- **Fallback.** Slots that do not parse, or a deriver that cannot read the beat, draw the beat as a `list` of its
  labels and record `fallback: { from, reason }`; a button with no action draws as `outro`. A beat with
  `visual.slots` never falls back: its refusal names the fields. Every refusal is listed in one `FillError`. Custom
  beats are listed in `custom`, not filled.

### The sim kit

A `sim` beat's picture is a model we ran (TP-4027). `src/sim/` holds its contract, in TypeScript only:

- **Contract.** A `SimModel` has an `id` (its `doctrine/sims/<id>.yaml`), a `version` bumped on any behaviour
  change, and `simulate(params, random)`. `simulate` is pure: its only randomness is `random`, the seed's
  `seededRandom` generator from `@titan-design/evidence`. `runPure` swaps `Math.random`, `Date.now` and
  `performance.now` for throwing stubs while a model runs, so a model that reaches for them fails with
  `SimPurityError`. The code registry is `SIM_MODELS`.
- **Sweep.** `sweepSim(model, base, { param, values }, seed, facet?)` runs one `SimRun` per point, each seeded with
  `` `${seed}:${param}=${value}` `` (plus `:${facet}=${value}` with a facet), so adding a point leaves every other
  point's run unchanged. The facet's values become the small multiples.
- **Trace.** `freezeSim(swept, doctrineSha)` validates an `explainer.sim-trace/v1` trace (`SimTraceSchema`: at most
  64 steps a run, at least one statistic with its Monte Carlo `se`) and keys it by the sha256 of its canonical JSON
  (`canonicalJson` from the eval store). A trace is a run artifact, never committed; only synthetic fixtures are.
- **Registry.** `loadSims` reads `doctrine/sims/*.yaml` (`sim-model/v1`: params with bounds, statistics with a
  tolerance and its `why`, and `fittedFrom`). `simDoctrineSha` is the sha a trace records as `doctrine`.
  `checkSims(SIM_MODELS, loadSims())` reports a model with no doctrine file (`E-SIM-NO-DOCTRINE`), a doctrine file
  with no model (`E-SIM-NO-MODEL`) and a doctrine statistic the model does not emit (`E-SIM-STAT-UNEMITTED`).
- **Check.** A sim slot's `claim` is `{ fact, statistic, at }`: the claimed value is the gathered `number` fact
  `fact`, the tolerance is the doctrine's for `statistic`, and `at` is the swept value whose run the claim is about.
  The script cannot set either. `simCheck(trace, beat, facts, doctrine)` is pure and passes a claim the run reproduces
  within its tolerance, edge included. Code holds the doctrine's tolerance between a floor and a ceiling:
  `E-SIM-TOL-NOISE` when it is under 3 standard errors (`SIM_NOISE_SE`), `E-SIM-TOL-LOOSE` when it is over a tenth of
  the claim (`MAX_SIM_TOLERANCE_REL`), and `E-SIM-CIRCULAR` when the statistic is one the model was fitted to
  (`fittedFrom`). The other failures are `E-SIM-MISS`, `E-SIM-NO-FACT` and `E-SIM-NO-RUN`. A sim with no claim is
  illustrative: it is swept and frozen but not checked, and its narration may not state a number
  (`E-SIM-UNCHECKED-NUMBER`).
- **Cut.** The resolve stage sweeps each `sim` beat (slots from the `slots` artifact under the owner's overrides),
  stores each frozen trace and a `sim-traces` artifact (trace sha and verdict per beat), and cuts every failing beat:
  it leaves `resolved.beats`, is listed in `resolved.cut` and in the notes, and tts voices none of them. The sim
  registry is part of `resolveConfig`, so a tolerance edit re-keys the stage. Its checks are `sim-check` (reported)
  and `sim-cut-orphan`, a gate that fails when the cuts leave a chapter with no beats. Every other consumer of
  `resolved` reads `keptBeats`, the script's beats less `resolved.cut`: `slot-overrides`, `emphasis-target`, tts and
  its `cue-resolution` gate skip a cut beat instead of failing on it.
- **Pilot.** `review-rounds` (`reviewRounds`) runs `prs` PRs: round 1 passes with chance `p1`, every later round with
  chance `q`. It emits `mean-reviews` (the first review counts) and `share-5plus`, whose closed forms
  `1 + (1 - p1) / q` and `(1 - p1)(1 - q)^3` are its test oracle. `fitLaterRoundPass(p1, share5plus)` solves `q` from a
  gathered 5+ share, so `share-5plus` is in `fittedFrom` and only the held-out mean can be claimed. Doctrine bounds are not
  enforced before `simulate`, so the model refuses a `q` under `MIN_LATER_PASS` and a `prs` over `MAX_REVIEW_PRS`
  itself: the resolve stage cuts that beat as `E-SIM-NO-RUN` rather than hanging. Its doctrine holds
  no article values; they come from `facts.jsonl` at run time.

## Composition page

`src/composition/` is one built Vite page that renders any `timeline.json` (TP-2991, milestone M9). Build it with
`pnpm --filter @titan-design/explainer build:page` (into `dist/composition/`) and open `index.html?timeline=<url of
timeline.json>`. The page fetches the timeline, then mounts react-ui's `MotionProvider` on a `seekClock` with the
beats in one commit, so `window.__titanMotion` appears only once frame 0 can draw; any `__titanMotion` renderer, such
as `@titan-design/frame-capture`, can capture it. Each beat's `kind` resolves through the registry in `registry.tsx`,
which parses its slots; an unknown kind or bad slots throw in the page, and a page error fails the capture. A timeline
with `provisional: true` carries a DRAFT badge. `baked.html` renders `fixtures/fixture.timeline.json` imported at
build time: the reference the runtime page must match byte for byte.

The registry holds `hook`, whose slots are `BEAT_SLOTS.hook`, and `catalogue` (react-ui's `FileCard`, `SchemaCard` and
`Annotate`) until `@titan-design/beats` is published (TD-907), when the page resolves kinds through that package
instead. The page reads only `durationS`, `provisional` and each beat's `id`, `kind`, `startS`, `durationS`, `cues`
and `slots`; `compileTimeline` (TP-2990) owns the rest of `timeline.json`.

`compileTimeline(board, words?)` (`src/render/compile-timeline.ts`) is the only reader of words.json: it writes heard
durations and beat-local cue seconds, or planned durations and `provisional: true` without words, and parses slots
with `BEAT_SLOTS` until `@titan-design/beats` publishes.

### `explainer render`: a storyboard to an MP4

```
pnpm explainer render <beats.json> --out <dir> [--audio <dir>] [--workers <n>] [--no-qa]
```

`src/render-cli.ts` (TP-2992 S2) parses `beats.json` with `StoryboardSchema`, compiles it with `compileTimeline` and
writes `<dir>/timeline.json`. It builds the composition page with Vite once per page-source sha (the files under
`src/composition/` minus tests, `src/beat-slots.ts` and the package's `package.json`) into
`<user cache>/explainer/composition/<sha>/`, serves the build and the timeline on loopback, and calls `renderVideo`,
which writes `<stem>.mp4` (stem from the `beats.json` name), `captions.vtt` and `render-manifest.json`.

- `--audio <dir>` is a narration bundle v1: `words.json` (`explainer.words/v1`) and one `<beat id>.wav` per board beat.
  A words.json that names a beat the board lacks, or a missing wav, fails before the page is built. Without
  `--audio` the timeline is provisional, so the page stamps DRAFT and the manifest records `draft: true`.
- `--workers` defaults to `min(16, availableParallelism())`.
- The render is QA-gated with the board video type's policy from `doctrine/qa/gate-profile.yaml`; held errors refuse
  the render and write `qa.json`. `--no-qa` skips the gate and the manifest records `qaGate: "skipped"`.

The `render` stage of `explainer run` takes the same path from script and resolved (above). TP-2993 writes the full first-video guide.
