---
"@titan-design/factory": patch
---

Add `bumpConsumers(host, services, { registry, regen })`. For each behind seat-book consumer it opens one PR on `shepherd/bump-consumers-<hash>`: the raised `@titan-design/*` specifiers plus the lockfile `regen` rewrote, written through the contents API with each file's expected blob. The PR body lists each `name: old → new` and each left-alone pair. Shepherd registers the PR once under the consumer seat's own policy. An open bump PR is checked for before any tree read. It is registered if it is not yet, even when the repo now plans as current or its read fails, and nothing new opens. A closed PR on the same branch is never reopened. A failed regen creates no branch. Nothing calls it yet.
