---
"@titan-design/factory": patch
---

`shepherd timeline` prints each verdict entry's outcome, as `verdict <stepId> <MERGE|FIX_FIRST|none>[ by <reviewer>][ (<note>)]`. A `none` whose own MERGE a seat WAIT held names Shepherd's own reviewer and reads `(seat WAIT from <seat>, Shepherd MERGE held)`. Any other `none` names no reviewer and gives its reason in the status line's words. A `sh-seat-recheck:<head>` step is now a verdict entry too. A verdict entry's JSON gains `note`, and a `none` carries its step's head. Verdict recording and routing are unchanged.
