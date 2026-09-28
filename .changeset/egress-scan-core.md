---
"@titan-design/egress-scan": minor
---

Add the egress-scan core: the `home-path`, `aw-data-path` and `private-term` rules, a `-U0` patch and commit parser, `scan`, the `.egress-allow` parser (a task id per entry, a literal path segment per glob, no private-term entries), the private term list parser (rejecting terms that match the empty string), and a report that carries locations and rule ids but never the matched text.
