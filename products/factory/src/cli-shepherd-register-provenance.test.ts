import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import type { CliDeps } from "./cli-types.js";
import { H1, REPO } from "./test-support/land.js";
import { BRANCH, shepherdFixture } from "./test-support/shepherd.js";
import { taskIndexFetch } from "./test-support/task-index.js";

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

function world(): { dbPath: string; deps: CliDeps } {
  const dir = mkdtempSync(join(tmpdir(), "factory-register-provenance-"));
  dirs.push(dir);
  const fixture = shepherdFixture();
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  return { dbPath: join(dir, "state", "factory.sqlite3"), deps: { workflows: fixture.workflows, routes: fixture.routes, host: { gatePollMs: 5 }, logger: silentLogger, fetch: taskIndexFetch() } };
}

async function register(w: ReturnType<typeof world>, flags: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  const argv = ["--db", w.dbPath, "shepherd", "register", `${REPO}#1`, "--task", "demo/T-1", "--implementer", "impl-a", "--offline", "--json", "--port", await deadPort(), ...flags];
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env }, w.deps);
  return { code, out, err };
}

const registrationOf = (result: { out: string }): Record<string, unknown> => JSON.parse(result.out).registration;

describe("shepherd register --reverts (TP-5446 F14)", () => {
  it("revert registration without --reverts is refused", async () => {
    const result = await register(world(), ["--kind", "revert"]);

    expect(result.code).toBe(EXIT.REFUSED);
    expect(result.err).toContain("needs --reverts");
  });

  it("records the PR a revert registration reverts", async () => {
    const result = await register(world(), ["--kind", "revert", "--reverts", "octo/widget#3"]);

    expect(result.code).toBe(EXIT.OK);
    expect(registrationOf(result)).toMatchObject({ kind: "revert", reverts: "octo/widget#3" });
  });

  it("refuses --reverts on a registration of another kind", async () => {
    const result = await register(world(), ["--kind", "feature", "--reverts", "octo/widget#3"]);

    expect(result.code).toBe(EXIT.REFUSED);
    expect(result.err).toContain("--reverts needs --kind revert");
  });

  it("refuses a --reverts that is not owner/repo#N", async () => {
    const result = await register(world(), ["--kind", "revert", "--reverts", "the bad merge"]);

    expect(result.code).toBe(EXIT.REFUSED);
    expect(result.err).toContain("owner/repo#N");
  });
});

describe("shepherd register records its registrant from the environment (TP-5446 F15)", () => {
  it("a registration from a terminal with no agent-chat name records owner", async () => {
    const result = await register(world(), []);

    expect(registrationOf(result)).toMatchObject({ registrant: { name: "owner", fixer: false } });
  });

  it("an agent's repeat registration takes over from owner, so the run's notices follow that agent", async () => {
    const w = world();
    await register(w, []);

    const repeat = await register(w, [], { AGENT_CHAT_NAME: "demo-seat" });

    expect(registrationOf(repeat)).toMatchObject({ registrant: { name: "demo-seat", fixer: false } });
  });

  it("an owner repeat never replaces the agent that registered first", async () => {
    const w = world();
    await register(w, [], { AGENT_CHAT_NAME: "demo-seat" });

    const repeat = await register(w, []);

    expect(registrationOf(repeat)).toMatchObject({ registrant: { name: "demo-seat" } });
  });
});
