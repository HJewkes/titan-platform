---
"@titan-design/github": minor
"@titan-design/factory": patch
---

Add `listForcePushes` to the GitHub port: a PR's head force-pushes with the head each replaced and the new head, read through GraphQL on the port's `gh` login, capped at one page of 100 with `ForcePushesTruncated` past it. `fakeGitHub()` seeds them through `fake.forcePushes`. The factory's carry seat check now reads force-pushes through the port, and its product-side reader is deleted.
