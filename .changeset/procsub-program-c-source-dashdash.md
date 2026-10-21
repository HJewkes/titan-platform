---
"@titan-design/tool-guard": patch
---

Read a process substitution as a script in three more places. A substitution that is the program itself (`exec <(...)`, `env <(...)`, `sudo <(...)`) is read as the file `exec ./x.sh` names is, instead of failing closed on an unreadable path. Under `bash -c STR`, every substitution after the string is read, since the string may run it by its positional (`bash -c 'bash "$1"' _ <(...)`). `source -- <(...)` and `. -- <(...)` read the substitution after `--`, and so does `source -- FILE`.
