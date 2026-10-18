---
"@titan-design/tool-guard": patch
---

Read `./name` for a bare name when the line changes `PATH` so it may list the working directory (TP-3338 b): `PATH=.:$PATH s`, `export PATH="$PWD:$PATH"; s`, `env PATH=. s`, a prefix `PATH` carried into `bash -c`, `env` or `nohup`, and, as a guess, a `PATH` the walk cannot read, a sourced file or an `eval` of run-time text. The file is read only when it is executable or the line writes it; a missing, non-executable, unreadable or opaque one is skipped, never refused. Relative subdirectories on `PATH` and run-time command words are not followed, so the common toolchain lines main allows still pass. An unchanged `PATH` keeps its reading.
