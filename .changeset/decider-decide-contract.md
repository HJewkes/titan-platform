---
"@titan-design/decider": minor
---

Add the decide contract: `DecideInput` and `DecideReply` as zod schemas with JSON Schema output, and `validate(reply, input, policy)`, which rejects cited principle ids missing from the input and out-of-range option indexes, and forces escalation under the category's confidence threshold.
