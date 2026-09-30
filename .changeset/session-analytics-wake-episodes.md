---
"@titan-design/session-analytics": minor
---

The cost report gains `wakeEpisodes`: the coordinator roles' wakes cut into episodes, each an
arrival and the requests up to the next one, mid-loop `queued_command` deliveries included. Per
wake cause it reports episodes, requests and cost per episode, and how many episodes took no
action by the TP-501 action facet (`noActionClasses`, default read-investigate, text-only and
other). The agent lifecycle notice is its own cause, `agent_lifecycle`. Each episode carries a
sender kind (seat, agent, broadcast, broker, none), and `pairs` is the sender-by-receiver
matrix. The text renderer lists the costliest causes per episode first. The `opus-coordinator`
spawn profile now maps to the coordinator role, so those seats report as `worker:coordinator`
instead of `worker:unknown`.
