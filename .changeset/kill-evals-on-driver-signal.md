---
"@titan-design/factory": patch
---

Kill every in-flight autoresearch eval process group (SIGTERM, then SIGKILL after the grace) when the driver receives SIGINT or SIGTERM, so detached evals no longer outlive an interrupted run.
