---
"@titan-design/factory": minor
---

On Linux, `titan-factory service install`, `status`, `uninstall`, `restart`, `deploy` and `plist` manage the systemd --user unit `titan-factory.service`, the launchd plist's twin (TP-1835). `service install --dry-run` prints the file and the calls install would make. macOS behaviour is unchanged, and `service check` still needs macOS.
