---
"titan-console": minor
---

Live story frames take pins and pass navigation keys (TP-3960, TP-3793 S5). The story bridge posts the story's named elements as `boxes` after each render, and `iframeSurface` hit-tests them behind the pin seam, so a pin placed on a live frame records the innermost element with a testId. In S4 a frame in pin mode fell back to its PNG; now only a coarse pointer's pin mode does. The bridge forwards only `[`, `]`, Escape and `?` to the page's key map. Enter, Cmd or Ctrl+Enter, digits and letters never leave the story. While a frame has focus it reads "Keys go to the story. Tap outside to answer." The bridge takes `args` from the console page alone and pushes them again after the next render. A frame that fell back to its PNG frees its mount slot, and Enlarge live counts toward the cap (TP-3932).
