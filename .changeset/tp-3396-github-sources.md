---
"@titan-design/factory": minor
---

The factory config gains a strict top-level `github` block: `sources` (`webhook` or `polling`, default `polling`), the `ingress` kill switch (`on` or `off`, default `off`), `pollingIntervalMs` (30 s to 10 min, default 60 s) and `backstopIntervalMs` (5 to 10 min, default 5 min). A polling interval longer than the backstop, or ingress on under polling, fails the load. Serve's health gains a `sources` field with the configured and effective mode, the reason, the interval and, when the file on disk has turned invalid since start, the `configError` that kept the last good value in force. Nothing acts on the effective mode yet.
