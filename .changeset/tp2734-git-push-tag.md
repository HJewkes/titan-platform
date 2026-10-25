---
"@titan-design/tool-guard": minor
---

Classify a git push of a tag as a release (`bash.release.git-push-tag`): `--tags`, `--follow-tags`, `-c push.followTags`, the `tag <name>` form, refspecs that send to `tags/`, release-shaped names (`v1`, `1.2.0`, `@scope/pkg@1.2.0`), and any name the local repository holds as a tag, through the new optional `ClassifyContext.isTag` port. `git push` long options resolve by unique prefix as git reads them (`--tag`, `--mirr`). Branch pushes keep their verdicts.
