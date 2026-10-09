---
"titan-console": patch
---

Relay the active-work daemon's and the agent-chat broker's `/events` to the browser through the console's own `/events`. Each upstream event becomes one frame named for its source, carrying only its kind and, for the broker, the row id and the two agent names; bodies, meta, refs, paths and the broker token never reach the browser. A reopened upstream stream sends one `reconnected` frame. Upstream dials back off from 0.5 s to 30 s, a silent or oversized stream is dropped, and the daemon's stop closes every upstream socket. The shell's `useRelayInvalidation` refetches the open pages' `work.*` and `graph.ego` reads on an active-work frame and their `agents.*` reads on a broker frame.
