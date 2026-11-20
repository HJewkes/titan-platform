---
"@titan-design/agent": minor
---

Add image attachments to a run. `AgentRunConfig.images` takes absolute PNG or JPEG paths for the claude-print harness. Each one is sent as a base64 content block before the prompt, over stream-json input. `CodexNativeOptions.images` passes one `-i` per image to `codex exec`, which is not yet verified against a live Codex. A missing or non-PNG/JPEG file fails before anything spawns. A run without images keeps its old args and stdin.
