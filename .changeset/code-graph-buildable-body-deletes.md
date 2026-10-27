---
"@titan-design/code-graph": patch
---

`planBodyDeletes` mutants now build: the early return is `if (true as boolean) return undefined as never;`, so the rest of the body stays reachable and TS keeps its narrowing. A bare return made the body unreachable, dropped narrowing, and failed the dts build with TS18048.
