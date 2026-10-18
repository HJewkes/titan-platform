---
"titan-console": patch
---

Add the `config.surfaces` read for this host's agent-chat `config.json` and profiles, the factory config, the console's `TITAN_CONSOLE_*` environment and each Claude Code account's `settings.json` and `.claude.json`. Only fields the catalog allowlist names carry a value; an undeclared key is listed hidden. Permissions and autoMode show as their rule texts, hooks as the commands they run, and `.claude.json` only as its trusted-folder count and MCP server names. The factory's `digest.push` URL is never named.
