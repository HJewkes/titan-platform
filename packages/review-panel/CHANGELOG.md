# @titan-design/review-panel

## 0.1.0

### Minor Changes

- d3e5f57: Add `classifyPr(facts, rules?)` and `DEFAULT_CLASS_RULES`: a pure classification of a pull request into `g10` or `standard` with its touch flags, from paths, kind, size and the caller's authority and policy hints.
- a18ef2a: Add `planPanel(cls, policy, headroom)`: a pure plan of a PR's review panel with each member's shape, profile, brief id and blocking flag, a spend estimate in points, at most 3 members and 1 opus member, and opus planned at its sonnet profile with `degraded: true` when headroom refuses it. `DEFAULT_PANEL_POLICY` has no panel table and plans the correctness member alone at the `g10` and `standard` profiles; `DEFAULT_PANEL_TABLE` is the opt-in class table.
- 37ef1c9: Add the Shepherd reviewer briefs: `reviewerBrief`, `correctionPrompt`, the owner-brief lines and `REFUSAL_SENTENCES`, with the constants they share.
- d4722b2: `ReviewerAgent` gains an optional `profile`, the profile the agent was spawned with, for a dispatch port whose roster reports it.
- 0a58927: Add `@titan-design/review-panel` with the review panel's types (`PrFacts`, `PrClass`, `PanelPlan`, `PanelVerdict`, `ReviewTarget`) and the reviewer ports a caller satisfies (`ReviewerDispatch`, `ReviewerReader`, `ReviewerAgent`, `ReviewerMessage`). Types only; no runtime behaviour yet.

### Patch Changes

- cf3b0d0: Build the reviewer brief's checkout-removal path from `reviewCheckoutName`, and give Shepherd one home each for its home-path prefixes and its run policy ceiling. No behaviour change.
- d4db9bc: Add `changedLineCount` and a `generated` glob list to `ClassRules`: generated registry files (CAPABILITIES.md, site reference pages, the reference sidebar, the capabilities guide, `.codewatch/check.json`) no longer count toward a large PR, unless they alone pass `largeLines` or a rename moved the file in from a written path. `ChangedFile` gains `previousPath` and `ReviewerFacts` gains `sizeUnread`.
- Updated dependencies [f34ae27]
- Updated dependencies [495e6f8]
- Updated dependencies [74f9f51]
- Updated dependencies [a8faac4]
- Updated dependencies [1aed39d]
- Updated dependencies [1fd9652]
- Updated dependencies [deb35d0]
- Updated dependencies [295acf8]
- Updated dependencies [59ba612]
- Updated dependencies [ff6ff86]
- Updated dependencies [c466784]
  - @titan-design/session-read@0.11.0
