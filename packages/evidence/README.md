# @titan-design/evidence

Checks that a model's cited evidence is real. A citation names a path, a 1-based line
range and a quote; `verifyCitation` confirms the path was allowed, the range exists and
was shown to the reader, and the quote occurs inside that range. It also groups
overlapping findings and scores planted control answers.

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

## Not in scope

Producing excerpts, deciding thresholds, and deciding what a failed control means for a
run. Those are product policy.
