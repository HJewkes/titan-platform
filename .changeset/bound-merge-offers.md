---
"titan-console": patch
---

A round's merge offer must say which head it merges. A pick-one with a "Merge #N" or "Ship" option, or a signsOff naming "#N at <sha>", needs a `merge` binding whose pr and head agree with that wording. Otherwise the round has a schema problem: `rounds.list` lists it as invalid and `rounds import` refuses it.
