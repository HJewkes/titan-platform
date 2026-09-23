---
"@titan-design/queue-mirror": minor
---

New package (TP-316): the `QueueSource` and `MirrorState` ports, `MemoryQueueSource` and `MemoryMirrorState` for tests, `redactPreview` (section 10 decision 3: bearer and basic auth, `token=`, `key=`, `password=`, and 32-plus hex or base64 runs), and `toItemInput`, which redacts an item and then fits its encoded content under 60,000 bytes, marking it redacted or truncated.
