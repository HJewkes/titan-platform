---
"@titan-design/frame-capture": patch
---

`screenshotFrame` waits 150 ms before its one retry of a "Unable to capture screenshot" answer; the immediate retry failed the same way under CI load. Any other error still throws.
