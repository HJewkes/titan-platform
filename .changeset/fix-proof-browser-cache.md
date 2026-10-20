---
"@titan-design/fix-proof": patch
---

Keep a missing browser from reading as a vacuous proof. The sandboxed base run now carries `PLAYWRIGHT_BROWSERS_PATH` (the parent's value, else `~/.cache/ms-playwright` of the invoking user), so Playwright finds its cache although `HOME` is the tree. A base file that failed with every test skipped, as when a `beforeAll` hook throws, now classifies as an `error` verdict with file state `hook-error` instead of `not-run`.
