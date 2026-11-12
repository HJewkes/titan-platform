---
"@titan-design/active-work": patch
---

The daemon log now says "session index released: hold cap ... reached" when the hold cap lets a pass through, instead of "session index resumed". A scheduler test now covers held, holdReason and heldSince.
