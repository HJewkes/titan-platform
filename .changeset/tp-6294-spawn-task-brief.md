---
"@titan-design/active-work": minor
---

`spawn` takes `--task <initiative>/<ID>`: it appends that task's `context.brief` block to the brief and logs each served ref to `retrieval-hits.jsonl` with trigger `spawn`, the task key and its section. Hit-log entries gain optional `task` and `section` fields. When the block is empty or degraded, the brief goes out unchanged and one stderr line names the reason; without `--task` nothing changes.
