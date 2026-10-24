---
"@titan-design/tool-guard": patch
---

Deny GitHub GraphQL `createRepositoryRuleset`, `updateRepositoryRuleset` and `deleteRepositoryRuleset` mutations, sent through `gh api graphql` or a curl/wget body to GitHub's GraphQL endpoint, as `authority-config` (`bash.config.gh-api-graphql-ruleset`, `bash.config.curl-graphql-ruleset`). `graphqlBranchWrites` reads them as unknown protected writes.
