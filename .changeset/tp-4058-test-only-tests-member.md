---
"@titan-design/review-panel": patch
"@titan-design/factory": patch
---

A test-only head that proceeds on its vacuous fix-proof no longer dead-ends under the review panel (TP-4058). Shepherd plans a fresh, blocking tests member for it, right after a g10-adversary hold's member, instead of leaving aggregate's unplanned tests seat empty and sending the head back as the proof's NO_REPRO. The tests member's brief asks, for each changed test, whether it would fail without the change it covers. Its MERGE lets the panel merge with no waiver; its silence is still no verdict, and its FIX_FIRST goes to the fixer. A diff that also changes source still ends as NO_REPRO, and an intent recorded before this change keeps the old NO_REPRO.
