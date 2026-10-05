---
"@titan-design/factory": patch
---

merge-facts records an unreadable Shepherd store in `unreadFacts` as its error class only (`store unreadable: <name>`), never the error's message, so no store error text reaches the gate reason or the public evidence comment.
