---
"@titan-design/tool-guard": patch
---

Read the body, and apply the opaque `#!` refusal, of any file a command runs by a path with a `/` (`./s`, `/abs/s`, `./s.bash`), not only `*.sh` (TP-3338). A file whose header is a structurally valid native executable for the host (ELF or Mach-O, with a NUL in its first line) is a program and is not read; any other file, a binary over the read cap or an unreadable file included, still fails closed. A by-path file whose `#!` names node, python or another non-shell interpreter is now refused with its own reason, which says to run it as `node ./x` or `python3 ./x` so the guard reads the body.
