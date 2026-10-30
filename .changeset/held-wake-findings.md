---
"@titan-design/factory": patch
---

A held send-back, whose successor agent-chat refused to start, no longer leaves its findings undelivered. The wake step keeps the wake's payload on its `held` record and messages it to the lineage's newest agent (else the registered implementer), recording the outcome as `predecessor`. The seat's held notice fences the payload as "wake findings", capped at `HELD_PAYLOAD_MAX_CHARS` (2000) characters.
