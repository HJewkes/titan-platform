---
"@titan-design/factory": patch
---

An approve-merge gate whose prompt carries the reviewer's owner brief or a skill-diff line below its policy line now reads as a land gate, so a coordinator's mechanical merge, merge-at-head, gate batches and console taps act on it. Land now writes a marker line on the gate naming each D21 fact that holds at the head, whatever the gate's rule: a skill change, a CI policy the reviewer judged weakened or wrote malformed, or changed files nobody read. Shepherd reports these facts from the MERGE evidence. A marked gate stays off the console tap, merge-at-head, standing answers, Ship answers and batches, and an earlier approval never follows to it. So does a multi-line gate opened before markers existed.
