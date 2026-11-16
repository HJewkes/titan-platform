## What

TP-6727 (P17): a prediction check for planning bets. `checkPrediction(bet, rows)` reads a bet's `prediction` (metric, direction, expected) against the scorecard week row of the bet's initiative for the bet's week and returns `confirmed`, `missed` or `unread` (no matching row, or the metric is null). The result is stored on the bet as the optional `prediction_check` field by `recordPredictionChecks` (`@titan-design/pm/node`). `orderBetsForSheet` groups bets by initiative and sorts a missed prediction before any other bet in the group.

Reuses the existing `BetSchema.prediction` and takes `WeekRow`-shaped rows structurally, so pm's pure root takes no dependency on session-analytics.

## Tests

Synthetic bets and rows: confirmed / missed in both directions, unread (absent metric, null metric, other week/initiative), missed-before-new-bet ordering, and the stored result. Sidecar mutants for both test files.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
