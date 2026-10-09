---
"@titan-design/health": minor
---

Add `probeHttp(target, deps)`: one GET of a health route returned as a sample, with a timeout over headers and body, latency on an injected clock, the HTTP code (redirects are not followed), a loose health/v1 read, `observe` dot paths, and a pid/port identity check so a stranger answering on the port reads as `fail`. A down target is a `fail` sample, never a throw; an error inside the probe is `unknown`. Credentials in the target URL are redacted from `output`.
