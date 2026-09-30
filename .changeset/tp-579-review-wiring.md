---
"@titan-design/factory": minor
---

Shepherd's review phase is wired from the config file. `shepherd.agentChatBin` names the `agent-chat` executable and must be an absolute path. `shepherd.review` takes `profile` and the optional `configDir`, `verdictTimeoutMs` and `sessionStartTimeoutMs`. With `review` set, `configuredRoutes` builds one `agentChatReviewerDispatch` and gives its roster to `transcriptReviewerReader`, and the reviewer starts in the checkout that the seat book binds to the PR's repo. With no `review` key no `agent-chat` process is started and `sh-review` answers `none`, as before. The load refuses `review` without `agentChatBin`, an unknown key under `review`, and a `profile` or `configDir` that is empty, starts with a dash, or holds whitespace, because each reaches the `agent-chat` argv as one argument. `shepherdRoutes` takes a second argument, `{ review? }`, and passes it to `reviewRoutes`. `FactoryRouteDeps` gains `review` and `isFrozen`.
