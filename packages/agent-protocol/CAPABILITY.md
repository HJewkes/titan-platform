# agent-protocol: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need identity, execution-phase or usage types that stay the same whichever harness (Claude Code or Codex) ran the work. For a canonical, zod-validated execution-trace record (run, attempt, call, gate, artifact, cost) with a privacy redactor, import `./trace`. To count usage without double-counting deltas and snapshots, call `foldUsage`.
