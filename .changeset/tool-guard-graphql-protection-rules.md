---
"@titan-design/tool-guard": patch
---

`graphqlBranchWrites` reads GraphQL `createBranchProtectionRule`, `updateBranchProtectionRule` and `deleteBranchProtectionRule` as branch writes whose target is always unknown, since a rule id or `pattern` glob cannot show which branches it covers (TP-2830 a).
