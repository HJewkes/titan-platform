---
"@titan-design/agent-dispatch": patch
"@titan-design/factory": patch
---

An agent-chat call that finds no broker listening now throws `BrokerUnavailableError` instead of a plain `DispatchError`. Exit 69 (agent-chat's EX_UNAVAILABLE) always means an unreachable broker, and agent-chat's no-autostart probe line ("broker unavailable: no broker is listening and AGENT_CHAT_NO_AUTOSTART=1 forbids starting one") joins the whole-line broker-down list, because `agent ls` and the other legacy verbs exit 1 on it.

Shepherd's review steps wait out an unreachable broker with a doubling wait (from the poll interval up to 2 min) for at most the review wiring's `brokerDownWaitMs` (default 15 min). Only then is the run held as no-reviewer, with the reason "broker unavailable (no broker answered for 15 min)". Before this change, a broker that came up after serve booted got the run held on the first refused roster read.
