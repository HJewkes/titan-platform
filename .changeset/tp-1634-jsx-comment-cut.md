---
"@titan-design/code-graph": patch
---

`minifySource` no longer adds a space where it cuts a JSX `{/* */}` comment between two elements or fragments (`</b>{/*c*/}<i>` now gives `</b><i>`); a cut between two words of JSX text still leaves one space.
