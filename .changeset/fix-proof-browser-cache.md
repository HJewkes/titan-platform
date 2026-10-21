---
"@titan-design/fix-proof": patch
---

Keep a missing browser from reading as a vacuous proof. A base file that failed with every test skipped, as when a `beforeAll` hook throws, now classifies as an `error` verdict with file state `hook-error` instead of `not-run`. The sandboxed base run also forwards the runner's `PLAYWRIGHT_BROWSERS_PATH` when it is set; staging a browser the sandbox user can read is not part of this change.
