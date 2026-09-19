---
"@titan-design/workflow": minor
---

Report every signal an output carries and key repeated human gates by iteration.

- `parseSignals` and `createSignalSetParser` return every signal, highest precedence first. `parseSignal` returns the head of that list. `high_risk` now leads the default order, so a risk score of 4 or more beats a PASS verdict.
- The default patterns match `**NEEDS REVISION**`, `verdict: **NEEDS WORK**` and `**NEEDS WORK**` again.
- Empty or whitespace-only output parses as `EMPTY_OUTPUT_SIGNAL` (`"empty_output"`) instead of `null`, so a silent reviewer escalates rather than passing.
- `unfilledVariables(template, vars)` lists the placeholders a template needs that `vars` does not supply.
- `assisted()` called again under the same `stepId` opens a new gate (`<runId>/<stepId>:n`, result key `stepId:n`) instead of returning the first answer. The first call keeps its existing key and gate id, and `runtime.signal` resolves whichever call is waiting.
