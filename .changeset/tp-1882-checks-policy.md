---
"@titan-design/factory": patch
---

Add `readChecksPolicy` and `checksDrift`: read the committed `.github/required-checks.json` at a PR's base ref and diff its contexts with the live required checks. An absent, malformed, unknown-key or unlisted-branch file reads unreadable, never as "no policy". Nothing calls them yet.
