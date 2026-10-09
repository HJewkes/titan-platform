---
"titan-console": patch
---

Add LAN mode: `TITAN_CONSOLE_HOST` adds an authenticated listener on one address of this machine, beside the unchanged loopback one. `TITAN_CONSOLE_LAN_NAMES` names the hosts it answers to, and `TITAN_CONSOLE_TOKEN` holds its secret. `titan-console login-link` prints a one-time, ten-minute sign-in link, and `titan-console token rotate` ends every LAN session.
