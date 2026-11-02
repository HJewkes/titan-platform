---
"@titan-design/factory": patch
---

`service deploy` refuses a version change to an irreversible fact step (today `merge`) while one of its intents has no terminal result, and fails closed when the factory db cannot be read.
