---
"@titan-design/pm": minor
"@titan-design/active-work": minor
"@titan-design/evals": patch
---

Add an initiative-level `visibility` (`owner-only` | `agent-visible`) to the brief and one predicate, `isAgentVisible`, in `@titan-design/pm` (TP-5453 P6). A brief with no `visibility`, or one that will not parse, is owner-only; a dated transitional list keeps the named code initiatives visible until their briefs declare it.

active-work: the workspace indexer stores only the initiative row of an owner-only initiative; `search`, the MCP search tool, `context.related`, the cross-initiative `context.graph` scan, `precedent search` and the bootstrap's foreign notes serve no owner-only initiative. `context.related` no longer reads the charter's `human_only_initiatives` and no longer reports a `charter` degradation. `set <slug> visibility <value>` is how the owner marks a brief, and it refuses an agent caller.

evals: the task-initiative allow-list and private markers come from `isAgentVisible` instead of a hard-coded list.
