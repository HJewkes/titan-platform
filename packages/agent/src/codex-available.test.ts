import { describe, expect, it, vi } from "vitest";
import { checkCodexAvailable } from "./index.js";

const inspection = { capabilities: { json_events: true, config_overrides: true, user_config_isolation: true,
  strict_config: true, model_selection: true, working_directory: true }, sandboxes: ["read-only"] };
describe("shared model-free Codex availability", () => {
  it("resolves the default through a version probe, then checks the surface", async () => {
    const inspectVersion = vi.fn(async (_path: string) => "codex-cli 0.162.1");
    const inspectCapabilities = vi.fn(async () => inspection);
    expect(await checkCodexAvailable({ env: { PATH: "/fixture" } }, { inspectVersion, inspectCapabilities })).toMatchObject({ ok: true, executablePath: "codex" });
    expect(inspectVersion.mock.calls[0]?.[0]).toBe("codex");
  });
  it("preserves the version-inspection rejection context", async () => {
    expect(await checkCodexAvailable({}, { inspectVersion: async () => { throw new Error("fixture missing"); } }))
      .toMatchObject({ ok: false, failure: { reason: "could not verify Codex CLI version: fixture missing" } });
  });
  it("rejects relative overrides before probing", async () => {
    const inspectVersion = vi.fn(async () => "codex-cli 0.162.1");
    expect(await checkCodexAvailable({ executablePath: "relative/codex" }, { inspectVersion })).toMatchObject({ ok: false });
    expect(inspectVersion).not.toHaveBeenCalled();
  });
});
