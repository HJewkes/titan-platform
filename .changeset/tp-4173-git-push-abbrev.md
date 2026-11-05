---
"@titan-design/tool-guard": patch
---

Read an abbreviated `git push` long option as git does, against `git push`'s own option list: `--ta` is `--tags`, `--fol` is `--follow-tags`, `--al` is `--all` and `--mir` is `--mirror`, so each classifies like its full form. An ambiguous prefix such as `--t` makes git refuse the push and now reads as a push to an unknown branch (TP-4173).
