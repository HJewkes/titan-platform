---
"@titan-design/daemon": patch
---

The file-watch test "never fires once closed" no longer races a real 10ms sleep against a 20ms debounce; fake timers hold the debounce pending until close. Test only; no production code changes.
