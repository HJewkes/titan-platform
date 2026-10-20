---
"titan-console": patch
---

A round's merge offer must say which head it merges. A pick-one with a "Merge #N" or "Ship" option, or a signsOff naming "#N at <sha>", needs a `merge` binding whose pr and head agree with that wording. Otherwise `rounds import` refuses it. A round already in the rounds dir still lists and takes a submit; the list marks an unbound one "unbound: no merge tap".
