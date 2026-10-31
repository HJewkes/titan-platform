# @titan-design/evals

The eval registry for units of work. Private; never published. Bin: `titan-evals`.

Slice E1 (TP-687) ships the spec schemas (unit, variant, case, suite with checks,
scorecard), strict and loose parsing, and canonical content hashing. Trials, checks,
judges and scorecard aggregation arrive in later slices.

```sh
titan-evals validate fixtures/summarize-note/unit.json fixtures/summarize-note/variants/single-pass.json
```

`validate` strict-parses each spec, re-reads the prompt files it references, and prints
its content hash. It exits 1 when a stored prompt digest no longer matches its file.

`fixtures/summarize-note/` is one synthetic unit with a variant, three cases (one per
split), a suite and a scorecard. Its hashes are checked by the tests, so editing a fixture
means re-running `validate` and updating the digests it reports.

`titan-evals corpus --db <factory.sqlite3> --repos-root <dir>` writes the review outcome corpus:
one JSONL row per reviewed head, labelled from git history and the factory database, which it
opens read-only. The label rules are in the reference page.

`replayCase` and `replaySuite` replay review-workflow cases through `reviewWorkflow` under
policy variants. A FIX_FIRST counts as a hit only when a verified citation names the case's path.
`SEED_CASES` and `FAILURE_FIXTURES` run in CI over fake ports with no model.
`reviewScorecard` scores one variant's results on catch, false blocks, sessions per head and
verdicts reached. `compare(candidate, incumbent)` accepts a retry or timing change on the fixtures
alone (no new loop, no fewer verdicts, no more sessions) and a plan change on catch and cost.

Full reference: `site/reference/evals.md`.

`titan-evals review-pr cases` builds the private cases for the `review-pr` unit in `units/review-pr/`:

```sh
titan-evals review-pr cases --corpus corpus.jsonl --repo owner/repo=<clone> \
  --active-work-root <dir> --out <dir outside every repo> --selftest
```

- A `caught` corpus row becomes a defect head: gold is FIX_FIRST plus the defect paths, which
  are the paths the review cited that the next head changed. A PR's latest `clean` row becomes
  a clean head with gold MERGE. Rows with any other label are skipped and counted.
- Six planted controls go on seeded clean heads, with the kinds rotating: a deleted assertion,
  an inverted condition, and an assertion weakened so the test no longer bites. Each control is
  a `tree` fixture under `<out>/trees/<id>/` holding `head/`, `base/` and `diff.patch`. Its gold
  is FIX_FIRST at the mutated path and line.
- Every case is `private`, and its split comes from a seeded hash. History cases use `repo`
  fixtures, and the trial materializes their bundles from the local clone with git only.
- The private exclusion (`src/private/exclusion.ts`) filters cases before controls are planted
  and asserts again before anything is written. `--selftest` runs its self-test first and
  aborts the build if it fails.
- The command refuses an `--out` inside a git work tree or one that is not empty. It writes
  `cases/*.json`, `suite.json` (sorted case hashes plus the checks in `src/review-pr/checks.ts`)
  and `manifest.json` (counts by kind, skipped rows by reason, excluded cases by reason).

`titan-evals implement-task export` builds the private cases for the `implement-task` unit from the classified
corpus (`cases.v3.classified.jsonl`). It selects candidates, drops private ones, then screens each class in seeded order
(a build and test at the base and merge commits) until `--per-class` cases are kept or the pool ends.

```sh
titan-evals implement-task export --corpus cases.v3.classified.jsonl --repos-root <dir of clones> \
  --active-work-root <dir> --out <dir outside every repo> --selftest
```

- `--repo owner/repo=<clone>` (repeatable) and `--repos-root` locate clones; `--owner` (default `HJewkes`) prefixes
  bare corpus repo names. `--classes`, `--per-class` (default 8) and `--seed` shape the draw.
- `--max-candidates <n>` caps each class's pool, so a first run screens a known few.
- `--dry-run` runs selection and filtering only and prints pool counts to stderr: no install, build or test, and no
  `--out` needed.
- `--selftest` runs the private exclusion self-test first and aborts the run if it fails.
- It refuses an `--out` inside a git work tree or one that is not empty, and writes `cases/*.json`, `suite.json` and
  `manifest.json` only after screening ends.

`titan-evals history build` is the history corpus builder (TP-949). It makes no `gh` or
GraphQL call; mirrors fetch over git smart HTTP unless `--no-fetch` is given.

```sh
titan-evals history build --until 2026-10-11T00:00:00Z --out <dir outside every repo> \
  [--repo owner/repo]... [--graph <path>] [--mirrors <dir>] [--active-work-root <dir>] [--no-fetch]
titan-evals history v2-parity --gh-cache <dir> --cases cases.v2.jsonl --as-of 2026-09-28T13:30:00Z
```

- `build` lists merged PRs at or before `--until` from the session graph (`mode=ro`) and computes
  each PR's shas, paths, test paths and size band from a bare mirror holding `refs/pull/*/head`.
  Default repos: the exclusion's engineering repos; a `--repo` outside them is excluded as `private-repo`.
- It writes `cases.jsonl` (canonical, sorted) and `summary.json` (`build_id`, per-repo counts, PRs
  `missing` facts and `excluded` as private, by reason) into an empty `--out` outside every work
  tree. Two `--no-fetch` runs with one `--until` are byte-identical.
- `v2-parity` recomputes label v2 from the cached REST JSON only and exits 1 on any mismatch.

`fixtures/measurement-audit/` is the second unit. It scores the `titan.measurement-audit/v1`
report that `titan-factory audit <area>` writes. The gold case is the Shepherd measurement audit:
44 metrics, each with a name, aliases, its definition and key words, and 11 capture gaps.

`scoreMeasurementAudit(gold, report, run)` parses the report with the read schema from
`@titan-design/health/metrics`. It returns recall, precision and F1 for metrics and for gaps, and
it takes `costUsd` from the run's recorded cost, since the report holds none.

- A report metric matches a gold metric when its title repeats the gold name or an alias. It
  also matches when the title has two or more content words, every one of them appears in that
  metric's name, aliases or definition, and at least one is a key word that sets the metric
  apart. Words that only say how a metric is measured ("count", "rate", "time") are allowed but
  never count toward a match. So shared domain words like "merged PR" or "per day" are never
  enough, and a word the metric can't explain ("conflicts", "commits") rules the title out.
  Report ids are ignored, so listing the source audit's ids scores nothing.
- A slice closes a gold gap only when at least a third of the metrics it names are that gap's
  key metrics. A slice that names every metric therefore closes no gap.
- Both matchings are one to one and maximal, so slice order never changes the score. Padding
  with extra metrics or slices lowers precision.
- The audit's twelfth slice, the metrics-registry entry, names no metric and is not a gold gap.
  Every audit appends it, so it cannot tell runs apart.

`samples/` holds a perfect report with reworded titles, a partial report and an empty report.
The tests score all three without running a model.

`units/explainer-*` are the explainer video units (TP-4011): `explainer-video` is the parent, and its `children` are
one unit per `explainer.<stage>` child workflow (`script`, `rewrite`, `eval`, `tts`, `render`, `qa`, `sheets`), with
the stage name as the prefix. Each unit has a `champion` variant, its cases and a suite.

- **Cases** are frozen upstream artifacts named by their explainer artifact-store sha (the sha `explainer stage --in`
  takes), never by text: the eight most recent renders as `recent-01` to `recent-08`, and the in-repo spike fixtures
  `fixture-v4` and `fixture-pipeline-explainer`, which also name their repo path and commit. The renders' scripts,
  facts, words, audio and MP4s stay outside this public repo; a case can only be run where the artifact store holds
  those shas. The split is a seeded hash of the video id (seed `explainer`), so one video sits on the same side in
  every stage. The owner-named hold-out, `fixture-pipeline-explainer`, is always `holdout`.
- **Suites** hold the stage's deterministic checks from the explainer workflow plan's §5.1 as `command` checks with
  `scope` set to the stage prefix: a gate check is `required` and `critical`, the rest `reported`. Judges are
  `reported` `command` checks until the owner's labelling round calibrates them. `cost_usd`, `wall_ms` and `retries`
  are reported metrics with no cap.
- **Scorecards are not built.** Running these suites over cases and aggregating a scorecard waits on TP-690 (the check
  engine). The seam is the stage record: `explainer stage <name> --json` prints `checks` (`name`, `gate`, `pass`,
  `detail`), and `explainer run report <runId> --json` carries each stage's `checkRows`. The same checks already run
  as steps inside every stage, so a production run report shows them today.

