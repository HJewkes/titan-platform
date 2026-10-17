---
"@titan-design/review-panel": patch
---

The reviewer brief no longer shows a CI table that leaves out a required check. When a required check-run has a name the table cannot carry (such as `build (22)`) or would fall past the row cap, the brief tells the reviewer to read CI itself instead of presenting a partial table as complete. Required rows now sort ahead of non-required ones before the cap applies.
