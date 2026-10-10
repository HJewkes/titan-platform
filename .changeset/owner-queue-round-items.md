---
"@titan-design/owner-queue": minor
---

Add relation keys and round questions as items. `askKey`, `roundAskKey`, `componentKey`, `tokenKey` and `topicKey` build `ask:`, `component:`, `token:` and `topic:` keys that relate items without merging them (`isMergeKey` is unchanged and false for each); `relationKind` reads one back and `prKey` builds a canonical PR merge key. `fromRoundQuestions(manifest, roundId, { openedAt, bindings? })` reads each round@2 question as an open OwnerItem, and `answeredFromFeedback(feedback, manifest, { roundId, openedAt, bindings? })` returns the answered ones from a feedback@1 file. With `buildOwnerRounds` bindings a question maps back to the item and option ids it asked, so a built and answered round round-trips. An owner answer can now carry `optionIds` (pick-many), `changeRequested` (a feedback revision request, so an open change request blocks a ship) and `variantComments`.
