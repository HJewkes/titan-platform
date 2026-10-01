---
"@titan-design/workflow": minor
"@titan-design/factory": patch
---

`ctx.authorize(stepId, request, options?)` asks the authority table before a governed action, in one durable step. `allow` returns `{ verdict: "allow", ruleId }`. `deny` records the decision and throws `AuthorityDeniedError` without opening a gate. `gate` opens a hitl gate bound to the rule (`rule: { table: "F5", version, ruleId, resolvers }`) whose answer must be `{ decision: "approve" | "refuse", subject }` echoing the request's subject; an owner approval returns `{ verdict: "approved", ruleId, gateId, resolvedBy }`. A refusal, a resolver outside the recorded rule, or a gate resolved with no resolver throws `AuthorityRefusedError`. A restarted run resumes onto the same gate and judges the answer by the rule recorded on it, so a table edit during the pause does not flip the decision. Replay returns or throws the recorded outcome without consulting the table. The runtime takes `authority: { table?, actor }`; the table defaults to `DEFAULT_TABLE`. `StepOperation` gains `"authorize"`. The factory's step guard (`guardedContext`, `StepKind`) passes `authorize` through its declaration check.
