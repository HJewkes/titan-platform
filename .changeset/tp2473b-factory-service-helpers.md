---
"@titan-design/factory": patch
---

The service unit renderer takes its systemd escaping, PATH-list, node-path and XDG unit-directory helpers from `@titan-design/daemon/service` instead of its own copies (TP-2473 b). Rendered plists and units are byte-identical.
