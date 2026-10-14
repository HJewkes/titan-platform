# @titan-design/explainer

Explainer video pipeline: beats.json and digest.json schemas, packet builder, finding attribution

Tier product of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Private, never published. This slice holds only pure code: file schemas and the two helpers
the build and repair steps share. Gather, plan, audio, assembly, render and the CLI land in
later slices.

| File | Contract |
|---|---|
| `beats.json` | `StoryboardSchema`: `video_type`, `title`, `chapters`, `beats` |
| `digest.json` | `DigestSchema`: a `since`/`until` window of items with stable ids |
| `lexicon.json` | `LexiconSchema`: written term to spoken form |

`video_type` and each beat's `type` are open kebab-case strings on purpose. Their allowed
values come from a doctrine registry planned at `products/explainer/doctrine/` (one profile
per video type, such as `repo-tour` or `repo-argument`, and one spec per beat type), which
will validate a storyboard against them. Until that lands, any kebab-case value parses.

`beats.json` has no version field. A format change adds an optional field or a migration;
the zod shape is what validates a file.

The map track (`map-state.ts`, `map-lints.ts`, `map-timeline.ts`) parses each beat's
optional `visual.map_state`, lints it against the layout's ids, and compiles it to timed
segments. A beat without `map_state` is off the map; the next map beat resumes where the map
last was.

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

`doctrine/rules.yaml` is the Q-rule registry (`rules/v1`): 55 script-quality rules in one id
space, each a hypothesis with a check. A rule row names the script fields it reads, the phase-1
ids it absorbed (`aliases`, each resolving to one rule), its `owner_support`, and an `l0` and/or
`judge` check that is either implemented (the L0 check ids it emits, or the rubric file citing
it) or `pending` with the slice that owns it. `loadRuleRegistry` parses it and rejects a
duplicate id or alias; `unimplementedL0Rules` lists rules whose claimed check ids no registered
check emits.

`explainer eval l0 <script.json> --config <id> [--rules <registry>] [--bench <dir>]
[--layout <layout.json>] [--parent <sha>] [--fail-on-ghosts]` runs the deterministic L0 checks
(`L0_CHECKS`: the map, why, evidence, voice and flow lints; the map lints need `--layout` and are
skipped without it), freezes the script and appends its rows and run record. A rule that claims
a check id no run check emits is a ghost: each prints one warning on stderr, and
`--fail-on-ghosts` turns them into exit 1. `doctrine/rules.yaml` holds which rules are
implemented or pending. `--rules` defaults to
the shipped registry and must parse as `rules/v1`. It exits 0 on a pass, 1 when an error-severity check fails (warnings never fail) and 2 on bad
input. L0 filters only: never rank scripts by how many checks they pass.

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
- `explainer eval smoke --judge <judge.json>` makes one tiny call through the configured
  judge, and skips a codex judge whose binary or cached login is missing, saying which.

Every verdict and answer must quote the beat it cites, verbatim and at least two words long.
A verdict with no quote, or a quote not in that beat's text on that track, is void (L1) or
scores 0 (L2). Every beat call ends with one known-bad canary beat, and every viewer call
asks about a component that does not exist. A run whose judge passes a canary, or whose call
fails, is untrusted: its rows are still written, and the command exits 1.
