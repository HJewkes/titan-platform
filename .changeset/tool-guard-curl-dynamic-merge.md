---
"@titan-design/tool-guard": patch
---

curl, wget and httpie sending a write method to a URL whose host, or whose `api.github.com` path, is known only at run time now classify as `bash.merge.curl-api {}` (TP-2728 b).
