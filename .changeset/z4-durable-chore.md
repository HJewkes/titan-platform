---
"@titan-design/factory": patch
---

The post-merge chore now runs in its own transient unit (`systemd-run --user`, or a detached process off Linux) and writes its result to `<stateDir>/chores`, so restarting serve no longer kills it. After a restart the post-merge route reconciles the step from those files. A finished chore is recorded and a running one is awaited. A chore that never started is retried. Only a chore that is gone and wrote no result parks the run.
