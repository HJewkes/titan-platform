---
"@titan-design/throughput": minor
---

Add `backtestSets(actuals, { origins, horizonDays, memberships, seed, draws, minSetSize, open, config, weekMinTasks })`: a rolling-origin back-test of `forecastSet`. At each origin it refits the class table, closure rates and week effects on rows done and started before it, then forecasts every seat-week, parent and milestone group whose first member starts in the horizon, with and without the week effect (closure off for seat-week groups). Per group kind it reports Wilson coverage of [p10, p90] for implementer hours, reviewer hours and USD, pinball loss on implementer hours, and groups censored by an open member; `groups` lists each scored group's actual and forecast totals.
