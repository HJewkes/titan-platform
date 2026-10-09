---
"titan-console": patch
---

Add the Agents pages. `#/agents` has a Roster tab over `agents.roster` and a Messages tab over `agents.messages`, with the broker's window caption. `#/agents/<name>` shows the agent's card, a Runs tab over `sessions.list` filtered to the agent and a Messages tab of its own messages. Tabs follow `?tab=`. `agents.messages` now lists every agent's messages when called without `agent`.
