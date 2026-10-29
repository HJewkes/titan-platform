---
"@titan-design/factory": patch
---

`titan-factory serve` picks up an edit to its config file without a restart (TP-4351). Each read through the config ref checks the file's inode, size and mtime, and re-parses only when they change. If the edited file fails to load, serve keeps the last good config and logs one warning until the file changes again. Live keys such as `shepherd.visualThreshold` and the `shepherd.gateReset` modes now take effect at the next read inside a running serve. Restart-class keys still keep their startup values.
