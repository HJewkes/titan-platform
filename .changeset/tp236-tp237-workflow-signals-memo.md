---
"@titan-design/workflow": minor
---

Report every signal an output carries and key repeated human gates by iteration.

- `parseSignals` and `createSignalSetParser` return every signal, highest precedence first. `parseSignal` returns the head of that list. `high_risk` now leads the default order, so a risk score of 4 or more beats a PASS verdict.
- The default patterns match `**NEEDS REVISION**`, `verdict: **NEEDS WORK**` and `**NEEDS WORK**` again.
- Empty or whitespace-only output parses as `EMPTY_OUTPUT_SIGNAL` (`"empty_output"`) instead of `null`, so a silent reviewer escalates rather than passing.
- `parseSignal` therefore returns a different value for two kinds of input it already accepted: an output carrying several signals now returns the highest-precedence one rather than the first pattern in the old key order, and empty output returns `"empty_output"` where it returned `null`. Check any code that routes on `StepResult.signal`.
- `unfilledVariables(template, vars)` lists the placeholders a template needs that `vars` does not supply.
- `assisted()` called again under the same `stepId` opens a new gate (`<runId>/<stepId>:n`, result key `stepId:n`) instead of returning the first answer. The first call keeps its existing key and gate id, and `runtime.signal` resolves whichever call is waiting. Stored runs keep their key shape. One upgrade case is handled rather than left to orphan a gate: a run paused by an earlier release inside `assisted(x)` after a `dispatch(x)` under the same step id waits on `<runId>/x`, and `assisted` adopts that gate when it is still pending and the bare key holds no result.
