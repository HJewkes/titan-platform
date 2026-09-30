# agent-dispatch: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

Code must start an agent-chat agent through the `agent-chat` CLI (brief on stdin, never argv), resume an ended agent's session with a message, read the agent roster, retire an agent, park an exited agent's worktree, or run any binary by absolute path with a minimal environment. It shells out and spawns nothing itself; to run one headless Claude turn in-process, use agent instead.
