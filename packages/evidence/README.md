# @titan-design/evidence

Checks that a model's cited evidence is real. A citation names a path, a 1-based line
range and a quote; `verifyCitation` confirms the path was allowed, the range exists and
was shown to the reader, and the quote occurs inside that range. It also groups
overlapping findings and scores planted control answers. The `./stats` subpath adds
small-sample intervals and tests for scoring eval runs.

Tier 0 of the titan-platform DAG. No dependencies, no Node built-ins. Lifted from the
repo-review tools (TP-354).

## Verifying a citation

```ts
import { lineSourceFromTexts, verifyCitation } from "@titan-design/evidence";

const source = lineSourceFromTexts({ "geo.py": "def area(r):\n    return 3.14159 * r * r\n" });
const shown = new Map([["geo.py", new Set([1, 2])]]);

verifyCitation(source, { path: "geo.py", lineStart: 2, lineEnd: 2, quote: "return 3.14159 * r * r" }, { allowedPaths: ["geo.py"], shown });
// { ok: true, citation: ... }
verifyCitation(source, { path: "geo.py", lineStart: 2, lineEnd: 2, quote: "return 3.14158 * r * r" }, { shown });
// { ok: false, reason: "quote-mismatch", detail: "quote not found in geo.py:2-2", ... }
```

Rejection reasons: `bad-range`, `path-not-allowed`, `path-unreadable`, `past-eof`,
`not-shown`, `quote-empty`, `quote-mismatch`. They are checked in that order, and the
first failure wins.

Quote matching collapses runs of whitespace on both sides, so indentation and wrapping do
not matter, but one changed character does. A quote is split on line breaks and on `...`
or `…` elisions; every fragment of three or more characters must occur in the cited lines.
A quote with no such fragment is `quote-empty`.

`LineSource` is the seam for file text: `{ lines(path) }` returns the lines, or
`undefined` when the path cannot be read. `lineSourceFromTexts` covers in-memory text;
read from disk, git or a snapshot by implementing the interface. `splitLines` drops the
trailing newline's empty entry the same way.

## Anchors pinned to a commit

`parseAnchor(text, pins)` reads a code anchor against pinned commits `{ repo, head, base? }`:
`head/<path>#L10-L20` and `base/<path>#L7` become a `LineRange` plus the pinned `rev`, and
`diff/<path>#L84-R90` gives two endpoints, `L` at base and `R` at head. It refuses a
reversed range, an absolute path, a `..` segment, a backslash, a blank path, and a side
with no 40-hex pin (`base/` and `diff/` need `base`). It only parses; whether the lines
exist is `verifyCitation` over a `LineSource` at the anchor's `rev`, such as
`revisionLineSource` from `@titan-design/code-graph/history`. `isFullSha` is the pin test.

`verifyAnchorText(text, pins, source)` does both: it parses, then checks each anchored line
with `verifyRange` (the location half of `verifyCitation`, no quote) over `source(rev)`.
A `diff/` anchor spanning both sides checks each endpoint at its own commit. A refusal reads
`head/a.ts#L10-L20: past EOF (15 lines)`; success quotes the first and last lines back.
`isAnchorForm` tells anchor-form text from a free string.

## Grouping overlapping findings

```ts
import { groupByOverlap } from "@titan-design/evidence";

groupByOverlap(findings, (f) => f.citations, { related: (a, b) => sharesWords(a.claim, b.claim) });
```

Two ranges overlap when they share a path and at least one line, so 10-12 and 12-14 group
and 10-12 and 13-14 do not. Grouping is transitive: an item that overlaps two groups joins
them. `related` adds a condition both items must meet.

## Planted controls

```ts
import { pickControls, placeControls, scoreControls } from "@titan-design/evidence";

const controls = pickControls(corpus, runId, 4);
const { sequence, positions } = placeControls(bundles, controls, runId);
const score = scoreControls(controls.map((c) => ({ id: c.id, label: c.expected })), answers);
// score.perLabel.confirmed is { expected, answered, correct, precision, recall }
```

The same seed always gives the same picks and positions. `scoreControls` counts an
expected control with no answer as `missing` and as a recall miss; answers for ids that
are not controls are ignored. Precision and recall are `null` when their denominator is
zero.

## Small-sample statistics

The `@titan-design/evidence/stats` subpath scores pass rates and paired comparisons at the
20 to 50 cases an eval suite has. No interval uses the normal approximation, which is
over-confident at that size.

```ts
import { aucInterval, betaBinomialInterval, mcnemar, minimumDetectableEffect, pairedBootstrap, rocAuc, wilson } from "@titan-design/evidence/stats";

wilson(7, 10);                       // { estimate: 0.7, lower: 0.397, upper: 0.892 }
betaBinomialInterval(7, 10);         // Jeffreys prior: { estimate: 0.7, lower: 0.394, upper: 0.907 }
pairedBootstrap(challenger, champion, { seed: runId }); // interval on mean(challenger[i] - champion[i]); a challenger win reads above 0
rocAuc(flagged, clean);              // 0.5 is chance, 1 is perfect; a tied pair counts half
aucInterval(flagged, clean, { seed: runId }); // stratified percentile bootstrap on rocAuc
mcnemar(2, 10);                      // { method: "exact", statistic: 2, pValue: 0.0386 }
minimumDetectableEffect({ n: 30, sd: 0.5 }); // 0.256
```

- `wilson` and `betaBinomialInterval` take successes and trials. The Beta interval is the
  equal-tailed posterior interval; pass `prior` to replace Jeffreys' Beta(0.5, 0.5).
- `bootstrapCI` and `pairedBootstrap` are percentile bootstraps with 10000 resamples by
  default. Pass one value per case, so trials of one case are never resampled as if they
  were independent. They draw from `seededRandom`, and the seed defaults to 0, so every
  call is reproducible.
- `rocAuc` is the Mann-Whitney probability that a positive score outranks a negative one. `aucInterval`
  resamples the two groups separately; pass `clusters` (one key per score, per group) to resample whole
  clusters, so correlated texts are not counted as independent.
- `mcnemar` takes the discordant counts (A passed and B failed, then the reverse). Below
  25 discordant pairs it runs the exact binomial test; from 25 it runs the
  continuity-corrected chi-square. Force either with `method`.
- `minimumDetectableEffect` is the smallest mean paired difference a two-sided z-test
  detects at alpha 0.05 and power 0.8, given the standard deviation of the per-case
  difference. It is a planning figure to print beside a "no detectable difference".

Invalid input (no trials, more successes than trials, a confidence outside (0, 1))
throws `RangeError`.

## Not in scope

Producing excerpts, deciding thresholds, and deciding what a failed control means for a
run. Those are product policy.
