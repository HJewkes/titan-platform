---
"titan-console": minor
---

Design round frames take numbered coordinate pins (TP-3773 S4). `a` or a frame's Pin button toggles pin mode and Escape leaves it; a click places a pin and focuses its note, and a press that moves more than 8 px places nothing. On a phone, Pin opens the frame full size and a tap there places the pin. Pins are sent as each frame's `annotations`, measured in frames.json's viewport width (now listed by `rounds.frames` as `viewportWidth`), else the frameReference width, else the PNG's pixels. A sent round draws its pins on the frame, read-only.
