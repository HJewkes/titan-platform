---
"@titan-design/tool-guard": minor
---

Read more git pushes of a tag as `bash.release.git-push-tag`: a bare version number (`1.2.0`), and a name of any shape that the local repository holds under `refs/tags/`, loose or packed, through the new optional `ClassifyContext.isTag` port. A push from a directory the command does not name literally falls back to the name shapes. `git push` long options now resolve by unique prefix as git 2.53 reads them, so `--tag`, `--fol`, `--mirr` and `--al` classify as `--tags`, `--follow-tags`, `--mirror` and `--all`.
