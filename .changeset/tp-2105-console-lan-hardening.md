---
"titan-console": patch
---

Refuse a `TITAN_CONSOLE_LAN_NAMES` entry with a `localhost` label anywhere in it (such as `localhost.localdomain`) or a numeric last label (such as `127.1`), which a browser reads as an IPv4 address.
