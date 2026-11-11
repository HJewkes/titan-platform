---
"@titan-design/factory": patch
---

`serviceRunsFromCheckout` now matches the deploy checkout's bin only in a systemd unit's `ExecStart` values (continuations joined, spacing around `=` ignored), so a comment, `Environment=` line or any other key that names the bin no longer passes the deploy guard. The XML-escaped acceptance test now uses a checkout path containing `&`.
