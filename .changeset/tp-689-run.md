---
"@titan-design/evals": minor
---

TP-689b: add resumable trial runs. `runTrials` runs variants × cases × trials one at a time, each in `runDir/<trialId>/` with its own trial file, workspace and `CLAUDE_CONFIG_DIR`, and writes `record.json` atomically when the trial settles. Run it again with the same run id to resume: settled trials are read back, a trial with only a trial file is hydrated, and the rest start. An `infra` trial runs once more from a cleared sandbox, and a run parked for recovery after a crash now counts as `infra`. `agentRoute` binds the launch port to a trial's sandbox over `runAgent`, or an injected launch. `createTrialHost` gains `resume`.
