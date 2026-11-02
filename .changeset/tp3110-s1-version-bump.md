---
"@titan-design/factory": patch
---

TP-3110 S1: `markersBehindVersion(db, step, version)` lists the current marker per identity of a step that was written under another version, reading through the `(step, version)` index. A bump therefore invalidates every marker of the step on every item, and a closure change with no schema change and no bump leaves them all valid. Read-only, with no caller yet besides its test.
