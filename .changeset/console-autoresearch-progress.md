---
"titan-console": minor
---

Add the autoresearch run page's wins and losses section: a scoreboard (kept, rejected, stopped, superseded, keep rate, $ per kept, wasted $), stops by rung, wins and losses ranked by |Δ/σ|, the planner digest's cell table, and the progress chart. The chart draws every decided idea and a best-so-far step line that only a kept idea moves, with a σ band that stays at the unlocked default until an outcome was judged against the target's lock pair count. It toggles between wall time and ideas evaluated, and a second panel plots cumulative spend. Until react-ui exports `LineChart` with a band (TD-1000), the chart is drawn with `Scatter` in one component. Each outcome in `autoresearch.run` may now carry the G7 `against` noise record (`sigma`, `pairs`).
