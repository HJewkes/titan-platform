---
"@titan-design/tool-guard": patch
---

Deny GitHub GraphQL `createRepositoryRuleset`, `updateRepositoryRuleset` and `deleteRepositoryRuleset` mutations, sent through `gh api graphql` or a curl/wget body to GitHub's GraphQL endpoint, as `authority-config` (`bash.config.gh-api-graphql-ruleset`, `bash.config.curl-graphql-ruleset`). `graphqlBranchWrites` reads them as unknown protected writes. A gh endpoint such as `graphql.json` or `%67raphql` counts as GraphQL, and a GraphQL query to GitHub's GraphQL endpoint that cannot be read (gh `query=@file`, `--input` or a run-time query; a curl, wget or httpie body from a file, the shell or httpie items) denies as an unknown ruleset write. So does a query whose text holds a gh fill, a gh query field any of whose bash brace expansions names a ruleset mutation (past 256 words it is unread), and a curl body word the shell may rewrite; `isGraphqlEndpoint` is now the one wide endpoint reading.
