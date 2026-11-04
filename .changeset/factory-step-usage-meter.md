---
"@titan-design/workflow": minor
"@titan-design/factory": minor
---

Meter agent-chat workflow steps from their transcripts and retire an agent mid-step when its slice's budget runs out. `StepUsage` gains `peakContextTokens`, and a code step can throw `CodeStepFailure` to keep what it spent.
