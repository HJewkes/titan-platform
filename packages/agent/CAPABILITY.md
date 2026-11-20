# agent: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You trigger one headless Claude Code or Codex run from code and want a typed result or typed failure under a hard budget. The default SDK harness needs `CLAUDE_CODE_OAUTH_TOKEN`; `harness: "claude-print"` runs one-turn structured calls on the CLI login instead (see Proven runtime paths). `images` attaches PNG or JPEG files to a claude-print run (proven on a subscription login, 2026-11-20); Codex exec takes them as `native.images` (one `-i` each), which is unverified against a live Codex. For retries, fan-out or durability, use workflow.
