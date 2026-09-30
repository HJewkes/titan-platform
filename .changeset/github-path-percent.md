---
"@titan-design/github": patch
---

`checkPath` now refuses a path containing `%`, as `checkRef` already did. A segment such as `%2e%2e` or `%2F` passed validation, and a URL layer could decode it into `..` or `/`.
