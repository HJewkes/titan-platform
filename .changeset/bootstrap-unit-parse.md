---
"@titan-design/factory": patch
---

`serviceRunsFromCheckout` now reads a systemd unit the way systemd does: only `ExecStart` values in `[Service]` that survive the last empty `ExecStart=` reset count, with CRLF normalised and `\` continuations joined. Comments, other keys, other sections and lines systemd cannot parse no longer pass the deploy guard. The plist path is unchanged. The XML-escaped acceptance test now uses a checkout path containing `&`.
