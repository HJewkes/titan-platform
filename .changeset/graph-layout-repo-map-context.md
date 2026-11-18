---
"@titan-design/graph-layout": minor
---

`emitRepoMap` takes an optional `context` ({ actors, externals, links }). When given, the map gains a level-0 `context` level: a `sys` box around every package, with the actors and externals outside it as top-level boxes and each link drawn as a level-0 protocol arrow. Without it the map and its sha are unchanged.
