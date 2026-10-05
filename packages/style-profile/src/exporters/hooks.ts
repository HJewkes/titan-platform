import type { Profile } from "../schema/profile.js";

interface ClaudeCommandHook {
  type: "command";
  command: string;
}

interface ClaudeHookMatcher {
  matcher: string;
  hooks: ClaudeCommandHook[];
}

interface ClaudeSettingsHooks {
  hooks: {
    PostToolUse: ClaudeHookMatcher[];
  };
}

// Claude Code passes the tool call as JSON on stdin; there is no file-path env variable.
const CHECK_EDITED_FILE =
  "f=$(jq -r '.tool_input.file_path // empty'); [ -z \"$f\" ] || codewatch check --fix \"$f\"";

export function generateHooksConfig(
  _profile: Profile,
): ClaudeSettingsHooks {
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [{ type: "command", command: CHECK_EDITED_FILE }],
        },
      ],
    },
  };
}
