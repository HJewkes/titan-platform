---
"@titan-design/factory": patch
---

Add `checkAnswer`, the binding check a console Ship answer must pass before it resolves an approve-merge gate: the request's own gate, GitHub's head and tree, the packet hash and binding, and the owner's feedback must all name the same head.
