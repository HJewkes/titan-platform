import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeRender, fakeBriefModels, fakeHost, fixture } from "../../workflow/run-fakes.test-helpers.js";
import { runPrCli, type PrCliDeps } from "./pr-cli.js";
import { fakeEdges, fakeGh, gate, PR, REPO, VIEW } from "./pr-fakes.test-helpers.js";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pr-cli-"));
  temps.push(dir);
  return dir;
}

/** A decision-brief run on a fake audition model and a fake clone; the CLI passes its own --data-dir. */
function briefHost(): NonNullable<PrCliDeps["host"]> {
  const fx = fixture();
  temps.push(path.dirname(fx.dataDir));
  return { ...fakeHost(fx, fakeBriefModels(), fakeRender()), gather: { readAt: async () => "" } };
}

function cli(deps: PrCliDeps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) => runPrCli(["pr", ...argv], { gh: fakeGh(), callEdges: fakeEdges(), out: (t) => out.push(t), err: (t) => err.push(t), ...deps });
  return { run, out, err };
}

describe("explainer pr gather", () => {
  it("gathers one PR on request and exits 0", async () => {
    const dir = await scratch();
    const { run, out } = cli();

    const code = await run("gather", PR, "--clone", "/clone/widgets", "--out", dir);

    expect(code).toBe(0);
    expect(out.join("")).toContain(`gathered 8 facts for ${PR}`);
    expect(existsSync(join(dir, "facts.jsonl"))).toBe(true);
  });

  it("exits 1 and prints each refusal code on stderr", async () => {
    const { run, err } = cli({ gh: fakeGh({ ...VIEW, title: "Untracked change", body: "" }) });

    const code = await run("gather", PR, "--clone", "/clone/widgets", "--out", await scratch());

    expect(code).toBe(1);
    expect(err.join("")).toContain("E-LINKED-TASK");
  });
});

describe("explainer pr trigger", () => {
  it("--dry-run lists the visual-gate PR and writes nothing", async () => {
    const dir = await scratch();
    const { run, out } = cli({ readWaiting: async () => ({ owner: [gate(), gate({ pr: 8, held: null })], seat: [] }) });

    const code = await run("trigger", "--dry-run", "--data-dir", dir, "--clone", `${REPO}=/clone/widgets`);

    expect(code).toBe(0);
    expect(out.join("")).toMatch(new RegExp(`^would-start ${REPO}#7 `));
    expect(out.join("")).not.toContain("#8");
    expect(await readdir(dir)).toEqual([]);
  });

  it("starts the brief, passing --port through to the waiting reader", async () => {
    const ports: (number | undefined)[] = [];
    const { run, out } = cli({ readWaiting: async (port) => (ports.push(port), { owner: [gate()], seat: [] }), host: briefHost() });

    const code = await run("trigger", "--data-dir", await scratch(), "--clone", `${REPO}=/clone/widgets`, "--port", "7411", "--json");

    expect(code).toBe(0);
    expect(ports).toEqual([7411, 7411]);
    expect(JSON.parse(out.join(""))).toMatchObject([{ pr: `${REPO}#7`, outcome: "started" }]);
  });

  it("runs each brief through the script only when --through script opts in", async () => {
    const stagesRun = async (...extra: string[]) => {
      const { run, out } = cli({ readWaiting: async () => ({ owner: [gate()], seat: [] }), host: briefHost() });
      await run("trigger", "--data-dir", await scratch(), "--clone", `${REPO}=/clone/widgets`, "--json", ...extra);
      const [row] = JSON.parse(out.join(""));
      const { stages } = JSON.parse(readFileSync(join(row.dir, "run.json"), "utf8"));
      return stages.filter((s: { status: string }) => s.status !== "not run").map((s: { stage: string }) => s.stage);
    };

    expect(await stagesRun()).toEqual(["gather", "audition"]);
    expect(await stagesRun("--through", "script")).toEqual(["gather", "audition", "script"]);
  });

  it("refuses a --through stage past the script", async () => {
    const { run } = cli({ readWaiting: async () => ({ owner: [gate()], seat: [] }) });

    expect(await run("trigger", "--data-dir", await scratch(), "--through", "tts")).toBe(2);
  });

  it("exits 1 when a visual-gate PR has no clone to index", async () => {
    const { run, out } = cli({ readWaiting: async () => ({ owner: [gate()], seat: [] }) });

    const code = await run("trigger", "--data-dir", await scratch());

    expect(code).toBe(1);
    expect(out.join("")).toMatch(/^refused /);
  });

  it("says so when no PR waits at the visual gate", async () => {
    const { run, out } = cli({ readWaiting: async () => ({ owner: [], seat: [] }) });

    expect(await run("trigger", "--data-dir", await scratch())).toBe(0);
    expect(out.join("")).toBe("no PR is held at the visual gate\n");
  });
});
