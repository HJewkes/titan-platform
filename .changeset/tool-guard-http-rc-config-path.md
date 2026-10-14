---
"@titan-design/tool-guard": patch
---

Guard curl, wget, wget2, httpie and xh rc files (`.curlrc`, `curlrc`, `_curlrc`, `.wgetrc`, `wgetrc`, `.wget2rc` and `wget2rc` in any directory, and httpie's and xh's `config.json`) as config paths, so an agent cannot write one in one call to change the method or URL of a later request (TP-2850).
