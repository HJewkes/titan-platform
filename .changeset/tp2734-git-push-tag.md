---
"@titan-design/tool-guard": minor
---

Classify a git push of a tag as a release (`bash.release.git-push-tag`): `--tags`, `--follow-tags`, `-c push.followTags`, the `tag <name>` form, refspecs that send to `tags/`, release-shaped names (`v1`, `1.2.0`, `@scope/pkg@1.2.0`), a name the local repository holds as a tag (the new optional `ClassifyContext.isTag` port), and a tag the same line creates, moves or deletes with `git tag` or `git update-ref`. A plain name pushed where the classifier cannot see the repository (`-C "$D"`, `cd "$X"`, `--git-dir`, `--work-tree`) reads as `bash.release.git-push-maybe-tag`, whose remedy is to name the branch as `HEAD:refs/heads/<branch>`. `git push` and `git tag` long options resolve by unique prefix as git reads them. Branch pushes keep their verdicts.
