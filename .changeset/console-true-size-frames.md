---
"titan-console": minor
---

Draw true-size frames and scale questions on a design round (TP-3772). A variant with a `frameReference` shows its reference ladder over the PNG, each bar its rung's share of the frame's height, with a Fit / 1:1 toggle: 1:1 draws the PNG at the frame's declared CSS width in a box that scrolls. A variant with a `scale` draws its candidates side by side in one full-size frame beside a ladder of sample text, from the PNG captured for each candidate, listed in frames.json under `<variant key>-<arg>-<candidate>` as the harness names its capture; an uncaptured candidate reads "Not captured". Other frames draw as before.
