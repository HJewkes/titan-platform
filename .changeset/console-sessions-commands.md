---
"titan-console": patch
---

Add the `sessions.list` and `sessions.timeline` commands. `sessions.list` pages indexed sessions from a read-only session graph with their agent, tasks, linked PRs and priced token usage. `sessions.timeline` builds a session's timeline from its transcript, found through the graph or, for a live session the graph has not indexed yet, under the Claude config roots. Both return a degraded entry when the graph file is absent or not migrated, and the timeline does so when an indexed transcript is gone.
