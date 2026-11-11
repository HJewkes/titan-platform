---
"@titan-design/code-graph": patch
---

Declare `zod` ^4 as a peer and dev dependency. The retrieval entry that code-graph loads imports it, so a consumer without zod failed at load.
