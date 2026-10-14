---
"@titan-design/tool-guard": patch
---

Add an internal `ghPathUnknown` matcher: true when a gh command's group, or the verb of a group the families read (`pr`, `release`, `workflow`, `gist`), is only known at run time (TP-2703 a). Not wired into any family yet.
