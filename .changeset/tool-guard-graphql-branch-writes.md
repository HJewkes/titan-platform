---
"@titan-design/tool-guard": patch
---

Add `graphqlBranchWrites` and `decodeGraphqlEscapes`, a matcher for the GitHub GraphQL mutations that move a branch ref (`updateRef`, `updateRefs`, `createRef`, `deleteRef`, `mergeBranch`, `createCommitOnBranch`, `enqueuePullRequest`, `createLinkedBranch`, `updatePullRequestBranch`), and `families/field-words`, which reads a `gh api` field word's key and value or marks them unknown until run time; for TP-2733 b, not wired into the merge family yet.
