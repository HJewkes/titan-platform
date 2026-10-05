---
"@titan-design/session-miner": patch
---

Guard the miner's own tables on a read-only foreign `--graph`. `status` reports `templates: 0` there, and `drain ingest`, `drain templates` and every `playbook` command exit 65 with a message naming the foreign graph instead of failing on "no such table".
