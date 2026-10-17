# agent-protocol: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need identity, execution-phase or usage types that stay the same whichever harness (Claude Code or Codex) ran the work. For a canonical, zod-validated execution-trace record (run, attempt, call, gate, artifact, cost) with a privacy redactor, import `./trace`. To count usage without double-counting deltas and snapshots, call `foldUsage`.

For the existing agent-chat dispatch socket/MCP shapes and durable identity/event DTOs, import `./wire`; it preserves legacy vocabulary and does not grant launch or permission authority.
