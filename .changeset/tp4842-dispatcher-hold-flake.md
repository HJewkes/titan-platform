---
"@titan-design/factory": patch
---

The review dispatcher test "gives up on a review still queued after the hold" now ticks once at the hold instead of 180 times, so it no longer spends minutes yielding to the real event loop on a loaded runner (TP-4842, seen on #3294 CI at 74354511). Test only; no production code changes.
