---
"@titan-design/agent-dispatch": minor
"@titan-design/coordinator": patch
---

`./limits` accepts optional `capacity` (`max_agents`, `reserve_slots`, `max_worktrees_per_repo`, `reserve_worktrees`) and `shepherd` (`spawn_gate.load5`, `spawn_gate.build_load5`, `review.max_concurrent`) sections and seat `hand_reserve` and `brief_gate` keys, read through the new `resolveCapacity` and `resolveShepherd`, which report each field's source. A malformed `capacity` or `shepherd` section is dropped into `ignoredSections`, reported by `checkLimits` as `ignored_section`, and closes no pool. The coordinator config's `limits` key accepts the same keys.
