# autoresearch: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

An agent loop should propose changes to a system, measure each against a frozen evaluator, and keep only those that beat the best by more than run-to-run noise, with the metric, guards and gates read from the target's own config. It runs on `workflow`; for a one-off fan-out of agent steps with no keep rule, use `workflow`'s `mapItems` directly.
