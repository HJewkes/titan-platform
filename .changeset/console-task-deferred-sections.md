---
"titan-console": minor
---

The Task detail page renders its shell from `work.task` alone, which no longer reads `context.graph` or `artifact.status`. Mentions and branch pull request state come from two new reads the page makes after the shell, each with a loading and an unavailable state: `work.taskMentions { id }` and `work.taskArtifacts { id, slug }`. `work.taskArtifacts` looks up only the task's own branches, with one `gh pr list` per GitHub repository cached for a minute, instead of active-work's one `gh` call per branch in the initiative. `work.task` drops `mentions`, `mentionsDegraded` and `artifacts`.
