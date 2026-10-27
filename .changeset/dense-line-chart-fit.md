---
"@titan-design/explainer": patch
---

A `line` chart of up to 12 points fits its stage box, with or without a legend. Past 7 points the columns close up to the small gap and the plot drops to 320 px, since the labels wrap to two lines; a legend takes another 120 px from the plot, and its own top margin is gone. Before, a 12-point line chart ran 120 px past the stage box and failed the page. The render stage version moves to m10c6.
