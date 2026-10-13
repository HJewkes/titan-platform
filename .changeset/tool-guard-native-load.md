---
"@titan-design/tool-guard": patch
---

Add `loadsNativeCode`, a matcher for bash `enable` lines that can dlopen a shared object (`enable -f FILE NAME`, or `enable NAME` searched on `BASH_LOADABLES_PATH`) (TP-2730 b); not wired yet.
