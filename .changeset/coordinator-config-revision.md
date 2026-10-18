---
"@titan-design/coordinator": patch
---

Add the coordinator document revision log: `configRevisionSchema`, `applyEdit` (sets one schema-declared field on a copy and re-checks the document), `diffDocuments`, `documentSha`, `revisionSha` and `verifyChain` (refuses a log whose revision does not name the previous revision as its parent).
