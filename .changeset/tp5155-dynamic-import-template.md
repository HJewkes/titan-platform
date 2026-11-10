---
"@titan-design/code-graph": patch
---

The dynamic-import extractor now records a template literal with no substitution, so ``import(`./x.js`)`` yields an `imports` edge (and a destructured binding a `references` edge) like the string-literal form. A template with a substitution still yields none.
