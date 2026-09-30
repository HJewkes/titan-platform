---
"@titan-design/factory": patch
---

Shepherd gains its production reviewer port. `agentChatReviewerDispatch({ agentChatBin, profile, cwdFor, configDir? })` implements `ReviewerDispatch` over `@titan-design/agent-dispatch`, which the factory now depends on. `ReviewerDispatch.spawn` takes the `ReviewTarget` as a third argument, so an existing implementation of the port must accept it. A spawn starts the reviewer under the one configured profile, in `cwdFor(target.repo)` with a leading `~/`, `$HOME/` or `${HOME}/` expanded, and sends the brief on stdin. A repo with no checkout path, or a path that is relative, missing or not a directory, is refused before `agent-chat` runs. Only an unreachable broker becomes `ReviewerBrokerDown`, which the step waits out; every other failure, a timeout included, is a refusal. Roster rows carry `transcriptPath` and `transcriptExists` for the verdict reader and leave `predecessor` and `fillTokens` absent, so no standing reviewer is resumed yet.
