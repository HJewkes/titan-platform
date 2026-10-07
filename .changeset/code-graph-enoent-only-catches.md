---
"@titan-design/code-graph": patch
---

Rethrow non-ENOENT errors from the `.gitattributes` read in `loadGeneratedPatterns` and the realpath in the indexer, instead of treating an unreadable file or root as absent.
