import type { Profile } from "../schema/profile.js";

interface ClaudeHook {
  event: "PreToolUse" | "PostToolUse";
  matcher: string;
  command: string;
}

interface ClaudeSettingsHooks {
  hooks: ClaudeHook[];
}

export function generateHooksConfig(
  _profile: Profile,
): ClaudeSettingsHooks {
  return {
    hooks: [
      {
        event: "PostToolUse",
        matcher: "Write",
        command: "codewatch diff --fix $TOOL_INPUT_FILE_PATH",
      },
      {
        event: "PostToolUse",
        matcher: "Edit",
        command: "codewatch diff --fix $TOOL_INPUT_FILE_PATH",
      },
    ],
  };
}
