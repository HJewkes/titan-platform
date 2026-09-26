---
"@titan-design/agent": minor
---

Add the `claude-print` harness to `runAgent`: `harness: "claude-print"` spawns headless `claude -p` on the CLI's own keychain login, so `CLAUDE_CODE_OAUTH_TOKEN` is not required. It runs one turn with no tools, hooks or MCP, passes `systemPrompt` as `--system-prompt` and `outputSchema` as `--json-schema` with a local zod re-parse, enforces the timeout and abort by killing the child process group, and still strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unless `allowApiKeyBilling` is set. New exports: `AgentRunHarness`, `AuthEnvCheckOptions`, `CLAUDE_PRINT_UNSUPPORTED_OPTIONS`, `CLAUDE_PRINT_KILL_GRACE_MS`, `buildClaudePrintArgs`, `claudePrintCapabilities`, `resolveClaudeBin`.
