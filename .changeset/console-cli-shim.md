---
"titan-console": patch
---

After a verified swap, `self-update --apply` writes a `titan-console` shim to `~/.local/bin` (`TITAN_CONSOLE_BIN_DIR`) that runs `current/apps/console/dist/cli.js` with its arguments, so seats call `titan-console` from `PATH`. It names `current/`, so a rollback keeps it valid; an unchanged shim is not rewritten, a new one is renamed into place, and a failed write is logged without failing the update.
