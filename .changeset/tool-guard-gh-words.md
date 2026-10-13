---
"@titan-design/tool-guard": patch
---

Read gh's command words the way cobra does, with gh 2.102's alias and extension slots, moved from agent-chat's leak-guard (TP-2707 a). `ghPathUnknown` now takes the command and is also true for an alias or extension slot, a hidden command word, or a `GH_CONFIG_DIR`, `XDG_CONFIG_HOME` or `HOME` prefix; not wired into a family yet.
