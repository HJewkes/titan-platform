---
"@titan-design/frame-capture": patch
---

Name each capture's spill directory after its process and sweep the spills of dead processes before a capture spills. A render killed mid-capture no longer leaves its frames on disk for good; a live process's spill is never touched, and a sweep failure does not fail the capture.
