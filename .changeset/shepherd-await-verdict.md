---
"@titan-design/factory": minor
---

Add the Shepherd step `sh-await-verdict`: it waits for the Verdict block in the final message of the dispatched reviewer's agent and session, written after dispatch and naming this PR at the exact head, and records the session-read locator. The deadline ends the wait with `none`.
