---
"@titan-design/factory": patch
---

The seat check can wait out a seat reviewer's WAIT over Shepherd's own MERGE: given a seat-wait timing, it re-reads the seat until the WAIT ends, lets the MERGE stand on a seat MERGE, records a `g10-disagree` override on a seat FIX_FIRST, and holds the MERGE as `seatHeld` when the WAIT outlasts the bound. Without the timing the WAIT still vetoes at once; nothing passes the timing yet.
