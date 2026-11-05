---
"@titan-design/factory": minor
---

Add the repo-agnostic `build-surface` workflow and `titan-factory build-surface start|status <owner/repo>`. A build spec's front matter names the repo's gate command, evidence path, validators, preview and deploy; the workflow runs slices in dependency waves through an agent-chat implementer route that waits for the agent's exit and reads its fenced JSON report, gates every head, reviews it, fixes under caps, opens the PR, registers it with Shepherd under the implementer's name and deploys after an owner approval. The owner queue carries cards for its `device-check`, `deploy-approve` and `final-walk` gates.
