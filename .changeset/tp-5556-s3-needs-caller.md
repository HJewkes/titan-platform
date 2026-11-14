---
"@titan-design/factory": minor
---

Needs reads now name their caller and filter by initiative in one place (TP-5556 S3). `collectNeeds` and `factoryContext` take a required `caller` (`owner` | `agent`) from `caller.ts`: serve's HTTP route is the owner and MCP an agent, and the `needs` and `digest run` verbs are the owner only when none of `AGENT_CHAT_NAME`, `AGENT_CHAT_AGENT_ID` or `CLAUDECODE` is set, so `digest run --dry-run` in an agent shell no longer prints owner-only asks. For an agent, every needs item whose initiative is not on active-work inventory's `withheld_from_agents: false` allow list is dropped, whatever its source (tasks, agent-chat asks, Morning items); untagged items stay, and an unreachable inventory withholds every tagged item and adds a gap line. `runNeeds` takes a `NeedsView` as its fourth argument.
