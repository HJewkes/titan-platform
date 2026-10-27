---
"@titan-design/code-graph": minor
---

Add `planBodyDeletes`, the body-delete mutant generator for extreme mutation (C-263 T2). For each changed function that coverage saw run, it emits one early-return edit (`return undefined as never;` after the body's opening brace) whose `find` is unique in the head text, widening back a line at a time up to fix-proof's 400-character edit cap. Expression-bodied arrows, constructors, generators, overloads and abstract members are skipped with reasons, as are unchanged, uncovered and over-cap functions. Over `max` (default 10), a sample seeded by the head sha is kept and the rest are reported as `capped`. The generator is pure and writes nothing.
