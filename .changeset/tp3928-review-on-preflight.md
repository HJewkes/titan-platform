---
"@titan-design/factory": patch
---

`shepherd.review.workflow: on:preflight` is live (TP-3928). Before any reviewer starts, the review intent refuses a head whose panel would dispatch a member planned onto, or lowered to, an uninstalled profile. The intent records the fixer fingerprint, the run is held through the no-reviewer hold, and the round ends `needs-fixer`. The new `await-fixer` route reviews the head again after the hold's wait and counts no failed round. `carried` joins the review outcomes on the merge path. A `shepherd.review.adversaryProfile` that is not installed headless, or whose lowered profile is not, now fails the config load. `shadow` and `off` are unchanged.
