# whiteboard (devdotfast/whiteboard) — repo review

Trimmed from the finished review for the gatherReview tests: three topics, four ledger rows, three claims, two digests.

- Remote: https://github.com/devdotfast/whiteboard
- Clone: /Users/you/projects/_review/whiteboard (pinned; never pull during the review)
- HEAD: 2ddf3eb6c13d97b1d04a932c21de9a92029adaf9 (2026-10-11 "Hide diff chrome on reviews and diagrams with nothing to compare (#1087)")
- Status: COMPLETE 2026-10-12. SUMMARY.md final (label final); coverage unread=0.

## Shape (skim, 2026-10-12)

Tracked files 7,602. Main language outside the vendored tree: TypeScript/TSX; Rust only in `diffr/`.

### Entry points

- CLI: `whiteboard` (npm `@dev.fast/whiteboard`, alias `review`; `packages/review/src/cli.ts`, `cli-runner.ts`), subcommands `api`, `mcp`, `server`, `trace`, `app`, `connect`, `migrate`, `share`, `info`.
- Agent surfaces: MCP server (`whiteboard mcp`, `packages/review/src/review-api/mcp.ts`), JSON tool API (`whiteboard api`, `agent-client.ts`, `agent-cli.ts`).
- diffr: Rust CLI/TUI `diffr/src/main.rs`, engine `diffr/crates/diffr-core`, plugin SDK `diffr/crates/diffr-plugin-sdk`.

Status: skim and structural done.
