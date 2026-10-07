---
"@titan-design/tool-guard": patch
---

Read a command word lower-cased too where the filesystem finds a program whatever its case (darwin, Windows), so `GIT push origin HEAD:main`, `/USR/BIN/GIT push`, `GH pr merge 5` and `NPM publish` classify as the lower-case spelling. The folded reading only adds commands: it never moves the directory or variables the as-written reading sets. Text it pipes on (`ECHO 'git push' | sh`) also reaches the next command, and a branch switch in it makes the head unknown for later commands, beside the head the as-written reading keeps. `nodeContext` turns it on by platform through the new `ClassifyContext.foldCase`; Linux keeps reading the word as written.
