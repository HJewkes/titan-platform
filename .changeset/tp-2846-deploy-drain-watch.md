---
"@titan-design/factory": patch
---

Deploy drain and watch (TP-2846). The restart drain no longer waits on a shepherd-pr run at `merge` behind another run on its repo's train, or on a run reading a seat's verdict (`sh-await-verdict`, `sh-late-verdict`, `sh-seat-recheck`). The 120 s watch judges run errors once, at the window's end, on the last two answers, against the drain's last pre-restart `/health`: a run the restart interrupted may stay recovery_required, but any new failed run, or a newly parked run that was idle at the restart, still rolls back. `/health` lists recovery_required run ids as `recoveryRequired`, and the deployer records the window's `{sha, windowEnd}` in `deploy-window.json`.
