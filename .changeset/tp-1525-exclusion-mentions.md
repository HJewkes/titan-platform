---
"@titan-design/decider": patch
---

`ExclusionSubject` and `SourceCandidate` take an optional `mentionedInitiatives` list; `isExcluded` excludes a row as `human-only-initiative` when any entry is human-only, and `extractSource` passes the candidate's list through. Rows without the list behave as before.
