---
"@titan-design/factory": patch
---

shepherd-pr parks the registered implementer's worktree in a new `sh-park:<head>` step once CI is green at a head, before that head's review. A refusal or an unreachable broker is recorded in the step output as `not-parked` and the run continues. `FactoryRouteDeps.park` and `ShepherdWiring.park` replace the default `agent-chat agent park` call.
