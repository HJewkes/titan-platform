---
"titan-console": patch
---

Add the `config.surfaces` read command: it lists the coordinator config files (charter and seat front matter, `burndown.config.json`, the owner switches in `seat-watchdog.json`) as rows with value, file, line, the inline comment and the decision numbers it names, plus each file's mtime and newest hand backup. Each surface declares an allowlist of safe fields; any other key is a hidden row with no value, and a parse failure names only the error code and line. `TITAN_CONSOLE_AUTONOMY_DIR` points it at the autonomy tree and `AGENT_CHAT_HOME` at the agent-chat files.
