---
"@titan-design/code-graph": patch
---

`isGeneratedFile` no longer marks files inside a directory for a trailing-slash `.gitattributes` pattern such as `vendor/ linguist-generated`. Git matches that pattern to the directory only, not to paths inside it, so `vendor/x.js` is not generated.
