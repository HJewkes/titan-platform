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

Full reference: `site/reference/evals.md`.

`fixtures/measurement-audit/` is the second unit. It scores the `titan.measurement-audit/v1`
report that `titan-factory audit <area>` writes. The gold case is the Shepherd measurement audit:
44 named metrics and 11 capture gaps.

`scoreMeasurementAudit(gold, report, run)` parses the report with the read schema from
`@titan-design/health/metrics`. It returns recall, precision and F1 for metrics and for gaps, and
it takes `costUsd` from the run's recorded cost, since the report holds none.

- A report metric matches a gold metric when its title shares enough content words with the
  gold name or an alias. Report ids are ignored, so listing the source audit's ids scores nothing.
- A slice closes a gold gap only when at least a third of the metrics it names are that gap's
  key metrics. A slice that names every metric therefore closes no gap.
- Both matchings are one to one and maximal, so slice order never changes the score. Padding
  with extra metrics or slices lowers precision.
- The audit's twelfth slice, the metrics-registry entry, names no metric and is not a gold gap.
  Every audit appends it, so it cannot tell runs apart.

`samples/` holds a perfect report with reworded titles, a partial report and an empty report.
The tests score all three without running a model.
