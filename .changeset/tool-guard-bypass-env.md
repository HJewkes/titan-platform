---
"@titan-design/tool-guard": minor
---

Remove the owner bypass: the hook now evaluates every call as an agent and ignores `TITAN_TOOL_GUARD_BYPASS`. The hook runs as the same OS user as the agent, so an agent could give any `claude` it started that variable, and whatever name, parent or terminal a check might demand. Breaking: `BYPASS_VAR` is no longer exported, `ActorObservation` loses `bypass`, and the log no longer writes `bypass` lines. Take a guarded action from a terminal outside Claude Code.
