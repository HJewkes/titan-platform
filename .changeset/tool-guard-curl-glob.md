---
"@titan-design/tool-guard": patch
---

Add an internal `expandCurlGlob`, curl's own URL glob expander (`{a,b}`, `[N-M]`, `[a-z]`, zero padding, `:step`, IPv6 literals kept as text, capped product) (TP-2735 a). Not wired into the request reader yet.
