---
"@titan-design/tool-guard": patch
---

Read a command word lower-cased too where the filesystem finds a program whatever its case (darwin, Windows), so `GIT push origin HEAD:main`, `/USR/BIN/GIT push`, `GH pr merge 5` and `NPM publish` classify as the lower-case spelling. The whole line is read a second time with every command word folded, so pipes, groups, branch switches and nested shells see the folded name. That reading only adds actions to the as-written one. The fold upper-cases then lower-cases, so the long s and ligatures APFS folds (`baſh`, `ſudo`, `ﬆdbuf`) read as `bash`, `sudo` and `stdbuf`. Builtins such as `cd` and `export` stay as written, because bash matches them exactly. `nodeContext` turns it on by platform through the new `ClassifyContext.foldCase`; Linux keeps reading the word as written.
