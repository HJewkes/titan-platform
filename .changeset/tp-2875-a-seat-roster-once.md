---
"@titan-design/factory": patch
---

The seat check reads the agent-chat roster once and hands those rows to each seat transcript read, so a slow broker no longer multiplies `agent ls` calls. Rows without transcript fields still fall back to the reader's own roster. The text match for "broker did not answer" is removed; agent-dispatch now classes that reply timeout as `DispatchTimeoutError`.
