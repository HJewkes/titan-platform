---
"@titan-design/explainer": patch
---

The dense-bar and dense-line fixtures' sequential Blues ramp now ends at `#4292c6` instead of `#08519c`, with `#6baed6` added between, so every stop clears WCAG 1.4.11's 3:1 non-text contrast on the dark theme's bar track and page ground. `contrast-check` exports `markGround`, the colour a drawn chart kind's marks sit on, and a test holds every fixture sequential stop to 3:1 against it. The render stage version is bumped.
