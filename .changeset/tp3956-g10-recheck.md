---
"@titan-design/factory": patch
---

A Shepherd merge waiting on a `g10-review` or `g10-adversary` hold now asks the `sh-g10-release` step again once after a restart, when the newest ask at that head was a recorded no. Before, a replayed no stood for good: a deploy that fixed the release rule (TP-3933) never freed a run already waiting at merge. The wait ends with no merge, land reads CI again, and the run asks the release under the code now serving, with every check of the rule kept. A no from that live ask is not asked again until the next restart.
