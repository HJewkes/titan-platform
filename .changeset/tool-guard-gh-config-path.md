---
"@titan-design/tool-guard": patch
---

Guard `~/.config/gh/config.yml` as a config path, so an agent cannot write a gh alias that shadows a built-in command (TP-2707 g). `hosts.yml` stays a secret only.
