---
"@titan-design/factory": patch
"@titan-design/github": minor
---

Recover a CI job that GitHub leaves queued or in progress after its workflow run has completed (TP-3996). `ci-wait` used to count such a job as a runner backlog and waited on toward the 135-minute ceiling with the merge train held. Now, once the job's run reads completed for 5 minutes, land reruns that one job in a recorded `ci-orphan-rerun` step, once per head. If the head orphans again, the run fails as a `ci-timeout`. The GitHub port gains `workflowRunStatus` and `rerunJob(repo, runId, jobId)`, which reads the run before it posts. The fake now reads a run with an open job as not completed.
