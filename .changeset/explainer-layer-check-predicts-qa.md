---
"@titan-design/explainer": patch
---

Make resolve's custom-layer build check at least as strict as qa: hold off-frame and low-contrast over qa's sweep at every 2 Hz phase on a 10 Hz grid, fail text contrast on any one sample, add qa's content-fill and words-per-frame gates, and refuse a `var(--color-…)` the theme does not define. Each refusal shares the one rebuild with a hint.
