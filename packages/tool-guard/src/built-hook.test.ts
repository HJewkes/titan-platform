import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The built bundle orders its modules differently from the source vitest loads, so a load-order crash shows only here.
// CI builds before it tests; locally run `pnpm build` first.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-built-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const event = JSON.stringify({
  tool_name: "Bash",
  session_id: "s",
  tool_use_id: "t",
  cwd: home,
  tool_input: { command: "git push origin HEAD:main" },
});

describe("the built tool-guard", () => {
  it("denies a push to main through the hook with exit 0", () => {
    const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input: event, env: { ...process.env, HOME: home }, encoding: "utf-8" });

    expect(run.stderr).not.toContain("TypeError");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('"permissionDecision":"deny"');
  });

  it("loads its entry point", async () => {
    await expect(import(pathToFileURL(join(dist, "index.js")).href)).resolves.toBeDefined();
  });
});
