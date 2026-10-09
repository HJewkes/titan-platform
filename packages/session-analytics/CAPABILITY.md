# session-analytics: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need cost, session class, role, episodes or a spend report over mined sessions, or the timeline read model behind a session view (turns, minute buckets, token and cost series). Also for agent-chat operations: it reads agent-chat's events.db through a connection the caller opened, parses broker.log lines, transcript denials and seat journals the caller reads, and reports blocked merges, dark agents and review fill. Session parsing is session-read; storage is session-graph.
