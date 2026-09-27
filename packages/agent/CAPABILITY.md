# agent: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You trigger one headless Claude Code or Codex run from code and want a typed result or typed failure under a hard budget. The default SDK harness needs `CLAUDE_CODE_OAUTH_TOKEN`; `harness: "claude-print"` runs one-turn structured calls on the CLI login instead (see Proven runtime paths). For retries, fan-out or durability, use workflow.
