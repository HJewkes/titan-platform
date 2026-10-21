---
"@titan-design/factory": patch
---

Shepherd: an approval that the accepted visual set gave now follows Shepherd's own clean merge-up of the base, and nothing wider. The base side must also change no path that matches the run's visual globs. The carry is logged as step `sh-approval-carry:<head>`, with rule `own-merge-up`, its proof and `origin: "approved-set"`. Land still trusts that answer for its own head only, so a later update asks again. Any other head, a base side that touches a visual path, or a policy with no visual globs asks the owner again. An owner's own approval follows as before.
