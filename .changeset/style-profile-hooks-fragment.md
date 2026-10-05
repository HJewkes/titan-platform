---
"@titan-design/style-profile": minor
---

The `hooks` export now emits Claude Code's event-keyed hooks shape (`hooks.PostToolUse[].hooks[]` with `type: "command"`) and runs `codewatch check --fix` on the file path read from the hook's stdin JSON, replacing a flat array that Claude Code never loaded and a `codewatch diff --fix` call the CLI does not accept. `exportProfile(profile, "hooks")` writes the fragment to `.claude/codewatch-hooks.json` instead of overwriting `.claude/settings.json`; merge it into your settings as the README describes. This changes the public return shape of `generateHooksConfig` and of the hooks export: an event-keyed hooks fragment written to `.claude/codewatch-hooks.json`.
