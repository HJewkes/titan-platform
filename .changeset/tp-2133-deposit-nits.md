---
"@titan-design/daemon": patch
"titan-console": patch
---

A `/rpc` `Content-Length` that is not a number now gets 413 from the body cap instead of passing it. The daemon README names the remaining loopback residual: the cap bounds one body, not how many are in flight. The console's `inbox.deposit` body cap is now three times the stored 64 KB cap, so a valid deposit whose non-ASCII characters arrive as `\uXXXX` escapes is no longer refused with 413.
