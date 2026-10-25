---
"@titan-design/tool-guard": patch
---

A `git push` long option given as a unique prefix now reads as the option git 2.53.0 runs, through one `GIT_PUSH_LONG` table: `--tag` and `--fol` read as a tag push, `--mirr` and `--al` as a push of every branch, and `--del` as a delete. An ambiguous prefix such as `--fo`, which git refuses, reads as nothing. The preference rules for branch deletes and skipped hooks read push options through the same reader, so `--del` and `--no-verif` count there too.
