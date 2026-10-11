---
"@titan-design/agent-dispatch": minor
---

Add `assertInstalledHeadless` and `installedProfilesDir` (ported from relay's profile guard): `dispatchToAgentChat` now refuses a profile whose installed file is not `"surface": "headless"`, and takes `profilesDir`. A spawn that times out throws `DispatchTimeoutError`. `listAgents` validates every required `AgentRow` field (now including `surface` and `generation`); the nullable fields are optional and dropped when mistyped.
