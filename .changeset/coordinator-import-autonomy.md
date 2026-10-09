---
"@titan-design/coordinator": minor
---

Add `importAutonomyTree` and `renderSeatBook`. The import turns parsed charter front matter, parsed seat front matter and a limits block into a `titan-coordinator/v1` document: repos move to the top level by id (identical entries share an id and gain a `shared_with` list when two seats use them; a repo two seats list differently keeps one id each), `config_dir` moves to the pool and the charter's hard stops and defaults become the policy. The render turns a document back into the seat files, restoring `config_dir` from each seat's pool. Both take parsed objects and read no files.
