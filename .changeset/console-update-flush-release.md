---
"titan-console": patch
---

Flush a new release to disk with `sync -f` and read it back before the self-updater swaps `current` to it, and refuse the swap (stage `flush`) when its `dist/cli.js` or `dist/index.html` is empty or its build-info names another sha. A new `ExecStartPre` start check moves `current` off a build a power loss left empty, or fails the start with the reason, and the bootstrap rebuilds a release whose stamp is empty.
