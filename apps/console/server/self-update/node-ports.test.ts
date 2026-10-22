import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STORY_PORT, resolveConfig } from "../config.js";
import { nodeUpdatePorts, smokeEnv, smokeRelease } from "./node-ports.js";
import { releaseCli } from "./release-smoke.js";

const HOME = "/srv/tester";

describe("the smoke build's environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // TP-3934: the smoke build bound the default story port, which the served console holds, and never answered /health.
  it("binds no story origin, even when the served console's unit names one", () => {
    vi.stubEnv("TITAN_CONSOLE_STORY_PORT", String(DEFAULT_STORY_PORT));

    const config = resolveConfig(smokeEnv(41234, "/srv/tester/smoke-state"), HOME);

    expect(config.storyPort).toBeNull();
    expect(config).toMatchObject({ port: 41234, stateDir: "/srv/tester/smoke-state" });
  });

  it("binds no story origin when the served console runs on the default", () => {
    vi.stubEnv("TITAN_CONSOLE_STORY_PORT", undefined);

    expect(resolveConfig(smokeEnv(41234, "/srv/tester/smoke-state"), HOME).storyPort).toBeNull();
  });
});

describe("the smoke check of a release on disk", () => {
  const releases: string[] = [];
  afterEach(() => {
    for (const release of releases.splice(0)) rmSync(release, { recursive: true, force: true });
  });

  function fakeRelease(cli: string): string {
    const release = mkdtempSync(path.join(tmpdir(), "titan-console-fake-release-"));
    releases.push(release);
    mkdirSync(path.dirname(releaseCli(release)), { recursive: true });
    writeFileSync(releaseCli(release), cli);
    return release;
  }

  // TP-3935: the daemon ran with stdio "ignore", so a bind failure read only as "answered /health with nothing".
  it("stops waiting when the daemon exits and reports the end of its stderr", async () => {
    const release = fakeRelease(`process.stderr.write("starting\\nError: listen EADDRINUSE: address already in use 127.0.0.1:7501\\n"); process.exit(1);`);

    const why = await smokeRelease(release, "b".repeat(40), { waitMs: 30_000 });

    expect(why).toMatch(/exited \(code 1\) before answering \/health as b{40}; its stderr ended: starting\nError: listen EADDRINUSE/);
  });

  it("runs a release's script with this node and returns its output", async () => {
    const release = fakeRelease(`console.log(JSON.stringify(process.argv.slice(2))); console.error("warn"); process.exitCode = 3;`);

    const run = await nodeUpdatePorts(path.join(release, "inbox")).runNode(releaseCli(release), ["self-update", "--smoke", "x", "y"]);

    expect(run).toEqual({ code: 3, stdout: '["self-update","--smoke","x","y"]\n', stderr: "warn\n", timedOut: false });
  });
});
