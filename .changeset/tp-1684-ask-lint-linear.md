---
"@titan-design/decider": patch
---

`lintAsk` stays linear on long tokens: the path and id-range patterns start at a token edge and an id's context is read from a bounded slice, so a 50 kB token or 7k distinct ids no longer take seconds. "Node.js" and "left/right/center" are no longer read as paths (AQ4), and "item(s)" no longer counts as a Principle enumerator.
