---
"titan-console": patch
---

LAN mode serves HTTPS only: `TITAN_CONSOLE_HOST` now needs `TITAN_CONSOLE_TLS_CERT` and `TITAN_CONSOLE_TLS_KEY` (for example the files from `tailscale cert`), login links are `https://`, and `docs/lan.md` is rewritten for a tailnet install with the tailnet name in `TITAN_CONSOLE_LAN_NAMES`.
