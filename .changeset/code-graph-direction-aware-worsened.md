---
"@titan-design/code-graph": minor
---

`diffCheckResults` and `bucketViolations` now count a violation as worsened when it moves
further past its threshold, rather than when its value rises. Before, a `metric-min` violation
whose value fell, such as `coverage_pct` dropping from 60 to 40 under a minimum of 80, was
counted as improved.

New exports, from the root and from `@titan-design/code-graph/analysis`:

- `violationExcess(ruleType, value, threshold)` returns how far past its threshold a violation
  sits. Larger is always worse: value over threshold for a maximum, threshold over value for a
  minimum. It returns null when the value or threshold is missing, or when the ratio has no
  meaning (a maximum of 0 or less, or a minimum rule's value of 0 or less).
- `compareExcess(before, after)` returns `"worsened"`, `"improved"` or `"unchanged"`, or null
  when either excess is null.

`bucketViolations` takes an optional fourth argument, `ruleTypeOf(ruleId)`; without it every
rule is read as a maximum. `BucketableViolation` now includes `threshold`. A pair whose excess
is null on either side stays in `unchanged` only, so it is neither worsened nor improved. A
caller that passes values without thresholds therefore gets no worsened or improved entries.
`delta` is still the raw `to.value - from.value`.
