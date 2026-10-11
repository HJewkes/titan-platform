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
