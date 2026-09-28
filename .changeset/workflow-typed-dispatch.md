---
"@titan-design/workflow": minor
---

Add typed dispatch output: `ctx.dispatch(stepId, template, { schema })` forwards the zod schema to the runner as `StepRunInput.outputSchema`, parses the output as JSON, and returns it as `StepResult.data` typed as the schema's output. An invalid payload throws the non-retryable `StepOutputInvalidError` after one runner call. Undeclared top-level `titan.trace.*` keys are carried into `data`, which is bounded by the new `maxStepDataBytes` runtime option (default 64 KiB). Replay re-derives `data` from the recorded output and fails a drifted run with `WorkflowSchemaDriftError`.
