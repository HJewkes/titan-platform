---
"@titan-design/tool-guard": patch
---

Deny GitHub GraphQL `createRepositoryRuleset`, `updateRepositoryRuleset` and `deleteRepositoryRuleset` mutations, sent through `gh api graphql` or a curl/wget body to GitHub's GraphQL endpoint, as `authority-config` (`bash.config.gh-api-graphql-ruleset`, `bash.config.curl-graphql-ruleset`). `graphqlBranchWrites` reads them as unknown protected writes. A gh endpoint such as `graphql.json` or `%67raphql` counts as GraphQL, and a curl, wget or httpie body to GitHub's GraphQL endpoint that cannot be read denies as an unknown ruleset write.
