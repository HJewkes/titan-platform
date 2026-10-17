import { describe, expect, it } from "vitest";
import { codexCapabilitiesFromHelp } from "./codex-runtime.js";

const help = `Options:
  -c, --config <key=value>
      --strict-config
      --ignore-user-config
  -m, --model <MODEL>
  -C, --cd <DIR>
  -s, --sandbox <SANDBOX_MODE>
          [possible values: read-only, workspace-write, danger-full-access]
      --json
      --output-schema <FILE>
`;

describe("Codex model-free capability evidence", () => {
  it("recognizes the explicit exec surface without asserting hook/MCP/rollout semantics", () => {
    expect(codexCapabilitiesFromHelp(help)).toEqual({
      capabilities: {
        json_events: true, config_overrides: true, strict_config: true,
        user_config_isolation: true, output_schema: true, model_selection: true, working_directory: true,
      },
      sandboxes: ["read-only", "workspace-write", "danger-full-access"],
    });
  });

  it("does not accept a flag mentioned only in explanatory prose", () => {
    const result = codexCapabilitiesFromHelp("For example use --json or --sandbox read-only.");
    expect(result.capabilities.json_events).toBe(false);
    expect(result.sandboxes).toEqual([]);
  });

  it("does not borrow another option's enum as sandbox evidence", () => {
    const result = codexCapabilitiesFromHelp(`Options:
  -s, --sandbox <MODE>
      Policy option.
      --example <VALUE>
          [possible values: read-only]
`);
    expect(result.sandboxes).toEqual([]);
  });
});
