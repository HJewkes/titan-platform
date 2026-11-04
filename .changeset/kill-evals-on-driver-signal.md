---
"@titan-design/factory": patch
---

Stop every in-flight autoresearch eval process group (SIGTERM, then SIGKILL after the grace) when the process driving it is stopped, so detached evals no longer outlive an interrupted run. Serve's close and the autoresearch CLI's SIGINT/SIGTERM handler share one shutdown: stop admission, release live runs, then stop the evals, so an interrupted run stays resumable and records no row for an eval the shutdown killed. The CLI then exits by the signal. An L0 suite cut off by an abort now answers with the abort, not a failed row.
