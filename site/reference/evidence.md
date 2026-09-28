# evidence

**Tier 0 · primitives.** No dependencies at all.

```sh
npm install @titan-design/evidence
```

## The problem it solves

A model asked to judge code answers with citations: a path, a line range and a quote. A
model will cite a file it was never shown, a line past the end of the file, or a quote
that is almost, but not quite, what the file says. Checking that by hand does not scale,
and checking it with `includes` over the whole file accepts a quote from the wrong place.

The primitive is `verifyCitation`: a citation is accepted only when its path is allowed,
its range exists and was shown to the reader, and its quote occurs inside that range after
whitespace normalization. Each rejection carries a distinct reason, so a caller can count
drops by cause.

Two smaller pieces travel with it. `groupByOverlap` merges findings whose cited ranges
share a line. `pickControls`, `placeControls` and `scoreControls` plant seeded controls
with known answers among real work and score the reader's per-label precision and recall.

## When to reach for it

Any pipeline where a model returns evidence that code must check before trusting it:
codewatch triage verdicts, repo-review findings, judge calls. For byte-offset pointers
into append-only transcripts, use [locator](./locator.md) instead; it resolves pointers
but does no content matching.

## Example

Verified against 0.1.0.

```ts
import { lineSourceFromTexts, scoreControls, verifyCitation } from "@titan-design/evidence";

const source = lineSourceFromTexts({ "geo.py": "def area(r):\n    return 3.14159 * r * r\n" });
const shown = new Map([["geo.py", new Set([1, 2])]]);
const cite = (quote: string) => ({ path: "geo.py", lineStart: 2, lineEnd: 2, quote });

verifyCitation(source, cite("return   3.14159 * r * r"), { shown }).ok; // true: whitespace only
verifyCitation(source, cite("return 3.14158 * r * r"), { shown });       // reason "quote-mismatch"
verifyCitation(source, { ...cite("x"), lineEnd: 3 }, { shown });         // reason "past-eof"

scoreControls(
  [{ id: "c1", label: "confirmed" }, { id: "c2", label: "justified" }],
  [{ id: "c1", label: "confirmed" }, { id: "c2", label: "confirmed" }],
).perLabel.confirmed; // { expected: 1, answered: 2, correct: 1, precision: 0.5, recall: 1 }
```

## What it deliberately does not do

It does not read files: callers implement `LineSource` over disk, git or a snapshot. It
does not build excerpts, pick thresholds, or decide what a failed control means for a run.
Those are product policy.

## Gotchas

- Rejections are returned, never thrown. Check `ok`.
- Reasons are checked in a fixed order (`bad-range`, `path-not-allowed`,
  `path-unreadable`, `past-eof`, `not-shown`, then the quote), and the first failure wins.
- Quote fragments shorter than three characters are ignored. A quote made only of them is
  `quote-empty`, not a match.
- Touching ranges overlap: 10-12 and 12-14 group. Grouping is transitive.
- `shown` is optional. Without it, any line in range counts as shown.

## Where it came from

Lifted from the repo-review skill's tools (`lib/judge.mjs` citation checks,
`lib/judged-verify.mjs` quote matching, the `merge.mjs` overlap rule, and the seeded
placement in `lib/control.mjs`) for codewatch's Layer 2 triage, the second consumer.
Unlike `merge.mjs`, grouping is transitive, and quotes must fall inside the cited range
rather than anywhere in the cited files. The repo-review scripts have not migrated onto
the package yet.
