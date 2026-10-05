import { describe, it, expect } from "vitest";
import { generateHooksConfig } from "./hooks.js";
import type { Profile } from "../schema/profile.js";

const sampleProfile: Profile = {
  schemaVersion: "1.0.0",
  author: "testuser",
  generated: "2026-02-27",
  sources: [],
  naming: {
    variables: {
      convention: "camelCase",
      confidence: 0.94,
      stability: "high",
    },
  },
  structure: {},
  documentation: {},
  errorHandling: {},
  formatting: {},
  patterns: {},
  idioms: { detected: [] },
  antiPatterns: { acknowledged: [] },
  overrides: [],
  severityThresholds: { error: 0.85, warn: 0.60, info: 0.40 },
};

const COMMAND =
  "f=$(jq -r '.tool_input.file_path // empty'); [ -z \"$f\" ] || codewatch check --fix \"$f\"";

describe("generateHooksConfig", () => {
  it("emits the event-keyed Claude Code hooks shape", () => {
    expect(generateHooksConfig(sampleProfile)).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: COMMAND }],
          },
        ],
      },
    });
  });

  it("reads the edited file path from the hook's stdin JSON, not an env variable", () => {
    const [entry] = generateHooksConfig(sampleProfile).hooks.PostToolUse;
    const command = entry?.hooks[0]?.command ?? "";
    expect(command).toContain(".tool_input.file_path");
    expect(command).not.toContain("$TOOL_INPUT");
  });

  it("calls codewatch check, which takes file paths and --fix", () => {
    const [entry] = generateHooksConfig(sampleProfile).hooks.PostToolUse;
    expect(entry?.hooks[0]?.command).toMatch(/codewatch check --fix "\$f"/);
  });
});
