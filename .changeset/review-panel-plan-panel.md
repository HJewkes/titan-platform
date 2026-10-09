---
"@titan-design/review-panel": minor
---

Add `planPanel(cls, policy, headroom)`: a pure plan of a PR's review panel with each member's shape, profile, brief id and blocking flag, a spend estimate in points, at most 3 members and 1 opus member, and opus planned at its sonnet profile with `degraded: true` when headroom refuses it. `DEFAULT_PANEL_POLICY` has no panel table and plans the correctness member alone at the `g10` and `standard` profiles; `DEFAULT_PANEL_TABLE` is the opt-in class table.
