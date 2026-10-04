# cluster: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You have high-volume semi-structured text (tool results, stack traces, log lines) and want a stable handful of templates with no model. Ids are deterministic for a given input order and survive restarts via snapshot; merged lines take the founding line's id.
