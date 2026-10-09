---
"@titan-design/factory": minor
---

Shepherd routes seat work to the registering seat instead of the owner. A `ci-failed` red no fixer took, an `sh-sent-back` send-back no agent took or a spent repair budget, and a `stuck-behind` update budget now record an `sh-seat-notice` step that messages the repo's seat. The run then takes the default action: it waits for a new head, or for `stuck-behind` runs `update-branch` again. The gate opens only when no notice was sent, and its prompt names why. `approve-merge` is unchanged.
