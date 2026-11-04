---
"@titan-design/factory": minor
---

Add the `retire-agent` owner op effect (TP-3622). The console-action route runs it under the new RET-OR row. It reads agent-chat's roster again and refuses unless all of these hold: the name's holder still has the confirmed agent id (otherwise `moved {currentAgentId}`), its session has exited, and it implements or authored no live Shepherd run. It then runs a plain `agent-chat agent retire` as caller `titan-console` and answers `retired {name, caveats}`. A `force: true` op is always refused. A replay of the record that retired answers `already`. A broker refusal answers 403 `resolver` verbatim. A broker that is down, or a serve with no `shepherd.agentChatBin`, answers 503. `owner-op.preview` reads a retire-agent op back as `agent`: the holder's roster row, whether it exited, and the live run that would stop it.
