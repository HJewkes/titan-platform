---
"@titan-design/tool-guard": patch
---

A command word with an odd bracket, such as `[]*+]`, no longer makes the glob compiler throw and the hook allow the whole line; bracket classes follow bash rules, and an uncompilable pattern fails closed (TP-1780).
