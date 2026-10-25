---
"@titan-design/explainer": minor
---

A custom layer that fails the compile gate gets one repair round through agent-chat. The `beat-builder` profile (a config value) gets the packet, the failing module and the error on stdin, writes `<beat>.tsx` into a scratch dir under the run dir, and the gate runs again. The agent's spend is priced from its transcript, found by the roster's session id, and joins the build's usage; its session id is kept as `repairSessionId`. A repair that still fails stays `needsRepair` with its spend and is not cached. The host's `layerRepairer` defaults to the agent-chat runner when an `agent-chat` binary is found; `null` turns it off.
