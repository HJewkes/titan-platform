---
"@titan-design/review-panel": patch
---

Clear the typed-lint baseline for the package: narrow the tool-call input and index reads instead of casting, and drop optional chains the types already rule out. No change for well-formed input.
