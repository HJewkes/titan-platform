---
"@titan-design/tool-guard": patch
---

Add `splitReading`, which reads a command's known unquoted expansions as bash field-splits them, beside the as-written reading. Words it cannot split exactly (mixed quoting, a custom or unknown IFS, case-unsure values) stay dynamic. A declaration the walk cannot read now forgets IFS too, so a later split fails closed.
