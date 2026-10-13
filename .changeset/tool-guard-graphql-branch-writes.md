---
"@titan-design/tool-guard": patch
---

Add `graphqlBranchWrites` and `decodeGraphqlEscapes`, a matcher for the GitHub GraphQL mutations that move a branch ref (`updateRef`, `updateRefs`, `createRef`, `deleteRef`, `mergeBranch`, `createCommitOnBranch`, `enqueuePullRequest`, `createLinkedBranch`, `updatePullRequestBranch`), for TP-2733 b; not wired into the merge family yet.
