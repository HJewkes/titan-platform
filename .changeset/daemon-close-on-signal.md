---
"@titan-design/daemon": minor
---

`closeOnSignal(handle, onClose?)` closes a started daemon on SIGINT or SIGTERM after running a caller's `onClose`, and closes the handle even when `onClose` rejects. The console and codewatch apps drop their identical local copies.
