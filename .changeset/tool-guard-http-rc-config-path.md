---
"@titan-design/tool-guard": patch
---

Guard curl, wget and httpie rc files (`.curlrc`, `curlrc`, `_curlrc`, `.wgetrc` and `wgetrc` in any directory, and httpie's `config.json`) as config paths, so an agent cannot write one in one call to change the method or URL of a later request (TP-2850).
