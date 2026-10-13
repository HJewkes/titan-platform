---
"titan-console": patch
---

Add the `approvals.flow` read command: it merges the factory's `needs.list`, the console's deposit spool and its review rounds through owner-queue `consolidate` into one Flow, with a gap line per unreadable source, fyi notices counted rather than ordered, and hidden after-answer recommendations stripped.
