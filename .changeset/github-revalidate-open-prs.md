---
"@titan-design/github": minor
---

Add `revalidateOpenPrs`, a conditional open-PR list sent with the caller's ETag. A 304 answers `notModified`, which GitHub charges no rate-limit point. The fake answers 304 the same way and counts each one in `notModified`.
