---
"@titan-design/agent-dispatch": minor
"@titan-design/factory": patch
---

`buildSpawnArgs`, `dispatchToAgentChat`, `buildResumeAgentArgs` and `resumeAgent` take an opt-in `launchedBy: "shepherd"` and optional `launchReason`, sent as `--launched-by shepherd [--launch-reason <text>]` (TP-3514, CC-1466). It is a roster record, never the `--spawned-as` gate input. A caller that does not opt in sends exactly the argv it sent before. Shepherd's spawns and resumes opt in; they need an agent-chat CLI that knows `--launched-by`.
