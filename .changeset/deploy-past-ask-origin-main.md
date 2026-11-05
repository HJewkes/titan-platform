---
"@titan-design/factory": patch
---

`service deploy --expect <sha>` now deploys origin/main when the deploy checkout's main is already past `<sha>` and on origin/main. Before, it refused with "already past", and the deploy pacer held that ask until it went stale. A rollback restores the build but leaves the checkout's main where it was, so after a rollback every older ask was refused this way. The refusal stays for a checkout's main that has commits not on origin/main.
