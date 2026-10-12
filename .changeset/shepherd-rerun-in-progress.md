---
"@titan-design/factory": patch
---

Shepherd's rerun step no longer gives up on a failed job whose Actions run is still in progress. It polls until the run completes, within a 20-minute `rerunQueueMs` bound, then reruns it. If another actor's rerun already replaced the failure, it settles without rerunning. The next ci-wait then reads the rerun's result, not the stale red.
