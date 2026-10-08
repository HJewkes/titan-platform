---
"@titan-design/code-graph": minor
---

`topDeadModules` takes an optional fifth argument, `{ view }`. The default `"all-consumers"` view is unchanged. The `"public"` view seeds reachability only from entry, barrel, config, script and `main.*` files, and tags a row that test, story or lab files still reach with the new optional `DeadModuleRow.reachableOnlyFrom` (`"lab"` beats `"story"` beats `"test"`). Story, lab, fixture and test files are never rows in either view. New types: `DeadModuleView`, `DeadModulesOptions`, `DeadModuleConsumer`, on the root and on `./analysis`.
