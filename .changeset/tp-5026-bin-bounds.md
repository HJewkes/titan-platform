---
"@titan-design/factory": patch
---

`serviceRunsFromCheckout` now bounds both ends of the bin match, so `<bin>.bak`, `<bin>x`, `/a+<bin>` and `/é<bin>` no longer count as the checkout's bin.
