---
"@titan-design/factory": patch
---

`serviceRunsFromCheckout` now ignores comment lines and `Environment=` lines when deciding whether the installed service starts the deploy checkout's bin, so a unit that names the bin only there no longer passes the deploy guard. The XML-escaped acceptance test now uses a checkout path containing `&`.
