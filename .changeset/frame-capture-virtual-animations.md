---
"@titan-design/frame-capture": minor
---

The virtual clock now covers `Date()` called without `new` (it threw before) and `document.timeline.currentTime`, and drives CSS animations, CSS transitions and Web Animations: after each timer, frame and seek, `__virtualTime.syncAnimations()` pauses every animation the page left running and sets it to virtual time. `openCapturePage` syncs once after load so load-time animations start at 0. An animation the page pauses or seeks itself is left to the page.
