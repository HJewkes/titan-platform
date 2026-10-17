# agent-protocol: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need identity, execution-phase or usage types that stay the same whichever harness (Claude Code or Codex) ran the work. For a canonical, zod-validated execution-trace record (run, attempt, call, gate, artifact, cost) with a privacy redactor, import `./trace`. To count usage without double-counting deltas and snapshots, call `foldUsage`.

For SDK-free execution targets, capability/limit assessments and generic progress/result/failure contracts and transcript source/observation/continuation DTOs, import ./harness; native execution stays in agent.

HarnessSourcePort describes injected discovery, scoped lookup and semantic observation/text reads; its capability assessments preserve unsupported/unverified operations without providing runtime adapters or finality guarantees.
