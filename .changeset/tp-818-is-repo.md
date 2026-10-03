---
"@titan-design/github": minor
---

Export a non-throwing `isRepo` predicate for bare `owner/name` slugs. `checkRepo` now shares its grammar: it applies GitHub's owner rules and refuses a `.git` suffix.
