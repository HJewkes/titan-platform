---
"@titan-design/owner-queue": minor
"@titan-design/factory": minor
"titan-console": patch
---

Add the `delete-branch` owner op (`{kind, repo, branch, tipSha}`) and its factory effect (TP-3623). The factory re-reads every check before it deletes: a managed repo (`shepherd.repos`), a valid branch name under an allowed prefix (`shepherd.consoleAnswers.branchPrefixes`, default `scratch/`), not the default branch, not protected, no open PR on or into it, no live Shepherd run on it and no agent on its own `agent-chat/<name>` branch. A tip that moved answers `moved`. The op maps to `destructive-remote`, whose owner-remote row denies it, so the console cannot run it until the authority table says otherwise. The console pins no PR for an op that names none.
