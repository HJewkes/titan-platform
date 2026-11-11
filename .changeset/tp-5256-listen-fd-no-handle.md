---
"@titan-design/factory": patch
---

The inherited-socket serve test no longer reads the listening fd through Node's private `_handle`. A small launcher binds the socket on fd 3 and execs serve with `LISTEN_PID` set to its own pid, as systemd does. Test only; no production code changes.
