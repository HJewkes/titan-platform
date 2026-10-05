---
"@titan-design/factory": patch
---

Shepherd's post-merge main CI read now carries the newer push sha in the classified read's type, so a route table edit that sends a read with no newer sha to `read-newer-run` fails to type-check instead of polling at "undefined".
