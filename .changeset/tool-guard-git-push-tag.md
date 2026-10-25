---
"@titan-design/tool-guard": patch
---

Read a git push that moves a tag as `release` (`bash.release.git-push-tag`): `--tags`, `--follow-tags`, `git -c push.followTags`, a refspec whose destination is `refs/tags/…`, `tags/…`, a `v<digit>` name or a changesets `[@scope/]pkg@<digit>` tag, and `tag <name>`. Branch-push verdicts are unchanged and still reported beside it.
