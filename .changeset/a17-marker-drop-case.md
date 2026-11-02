---
"@titan-design/factory": patch
---

The TP-3105 S4 A17 case, "a dropped marker replays from its recorded read values", now runs in both event-source modes under `a17Event`. It writes a `check` marker for the live head, deletes the marker's output blob, and pushes a new head. It then checks that rerunning the step on the recorded head read reproduces the recorded output digest without a new feed read. Test only; no production code changes.
