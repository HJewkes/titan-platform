---
"@titan-design/tool-guard": patch
---

Read the push config a git command passes itself. `git -c remote.<r>.push=…` and `-c push.default=upstream` with `-c branch.<name>.merge=…` can send a plain `git push` or a colon-less refspec to a protected branch; those now deny as `bash.merge.git-push-protected`. A `--config-env` on a push-shaping key, `-c include.path` or `includeIf.*.path`, `push.default=upstream` without the pushed branch's upstream, and a run-time `-c` word whose key may shape the push deny with branch `unknown`. `-c remote.<r>.mirror` and `-c push.default=matching` deny as `bash.merge.git-push-all`. `GitInvocation` gains `configEnv` and `configUnsure`.
