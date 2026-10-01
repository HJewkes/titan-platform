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
