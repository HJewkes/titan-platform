import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import { REPO } from "./test-support/land.js";
import { shepherdFixture } from "./test-support/shepherd.js";

const AGENT = { AGENT_CHAT_NAME: "demo-impl", AGENT_CHAT_AGENT_ID: "id-1" };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function deadPort(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return String(address.port);
}

async function visualWeek(extra: string[]): Promise<{ code: number; out: string; err: string }> {
  const dir = mkdtempSync(join(tmpdir(), "factory-visual-week-"));
  dirs.push(dir);
  const fixture = shepherdFixture();
  const deps = { workflows: fixture.workflows, routes: fixture.routes, host: { gatePollMs: 5 }, logger: silentLogger, serveWaitMs: 50 };
  const argv = ["--db", join(dir, "factory.sqlite3"), "shepherd", "visual-week", "--repo", REPO, "--port", await deadPort(), ...extra];
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env: AGENT }, deps);
  return { code, out, err };
}

describe("titan-factory shepherd visual-week with no serve answering, in an agent env", () => {
  it("accepts --images with a relative directory and builds the batch with a section list", async () => {
    const result = await visualWeek(["--images", "round"]);

    expect(result.code).toBe(EXIT.OK);
    expect(JSON.parse(result.out)).toMatchObject({ questions: [], sections: [] });
  });

  it("without --images the batch carries no sections", async () => {
    const result = await visualWeek([]);

    expect(result.code).toBe(EXIT.OK);
    expect(JSON.parse(result.out)).not.toHaveProperty("sections");
  });
});
