---
"@titan-design/factory": patch
---

Shepherd sends failed review rounds that never got an adversary verdict to a diagnosis planner (TP-3796). When every counted round failed on infrastructure and no adversary returned a verdict (a refused adversary spawn counts as none), Shepherd starts no fourth blind review and opens no owner gate. It records `D7/no-verdict-diagnosis` and spawns one planner at `shepherd.diagnosisProfile` (default `bd-planner`, passed to agent-chat as configured). The planner's brief carries the PR, the head, each silent reviewer's session id and transcript path (or "never started" with the refusal), and the `serve.err.log` lines that name them. The run then waits for a new head. A planner that cannot start falls back to the D7 ops notice. D7's fallback reviewer still applies when an adversary ran and returned a verdict. `GATE_DEMOTIONS.neverVerdictDiagnosis` (default on) reverts it.
