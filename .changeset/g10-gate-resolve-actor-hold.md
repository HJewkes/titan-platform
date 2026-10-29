---
"@titan-design/factory": patch
---

Shepherd holds a pull request `g10-adversary` when it changes a file on the list of files that decide who may resolve a gate. A test traces the resolve sinks with the TypeScript checker (callers, implementers, forwarders and `GateResolver` builders) and fails when a file in that closure is not on the list. Files that build no resolver, such as the owner's skill-diff guard, are listed by hand. Test-only changes stay unheld. The test is a heuristic trigger, not a completeness check. Forms it misses are listed in the Shepherd guide and tracked as tasks.
