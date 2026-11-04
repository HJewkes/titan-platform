---
"@titan-design/factory": patch
---

Stop every in-flight autoresearch eval process group (SIGTERM, then SIGKILL after the grace) when the process driving it is stopped, so detached evals no longer outlive an interrupted run. The autoresearch CLI's in-process runs stop their evals on SIGINT or SIGTERM and then exit by the signal; `titan-factory serve` stops them before its own shutdown, which it keeps.
