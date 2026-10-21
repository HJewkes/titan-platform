import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../cli.js";
import { factoryWorkflows } from "../workflows.js";
import type { PlannerRun, RunOptions } from "./inputs.js";

interface Call {
  file: string;
  args: readonly string[];
  options?: RunOptions;
}

let dir: string;
let calls: Call[];
let merged: { code: number; stdout: string };

const run: PlannerRun = async (file, args, options) => {
  calls.push({ file, args, options });
  if (file === "gh") return { ...merged, stderr: merged.code === 0 ? "" : "gh: rate limited" };
  return { code: 0, stdout: "", stderr: "" };
};

const spawns = (): Call[] => calls.filter((call) => call.args[1] === "spawn");

function fixture(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

function writeConfig(extra: Record<string, unknown> = {}, inputs: unknown[] = []): string {
  return fixture(
    "planner.json",
    JSON.stringify({
      cwd: dir,
      brief: join(dir, "brief.md"),
      inputs: [
        { name: "plan", file: join(dir, "plan.md"), selfWritten: true, dropSections: ["Revision log"] },
        { name: "decisions", file: join(dir, "decisions.md") },
        { name: "tasks", dir: join(dir, "tasks"), suffix: ".yml" },
        { name: "merged", command: ["gh", "pr", "list", "--state", "merged"] },
        ...inputs,
      ],
      ...extra,
    }),
  );
}

async function wake(config: string, ...flags: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const io: CliIo = { stdout: (text) => void (out += text), stderr: (text) => void (out += text), env: { XDG_STATE_HOME: join(dir, "state") } };
  const code = await runCli(["planner", "wake", "--config", config, ...flags], io, { workflows: factoryWorkflows, routes: [], planner: { run, now: () => new Date("2026-01-02T03:00:00Z") } });
  return { code, out };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "planner-wake-"));
  calls = [];
  merged = { code: 0, stdout: "101 abc123 2026-01-01T10:00:00Z\n" };
  mkdirSync(join(dir, "tasks"));
  fixture("brief.md", "You are the planner.\n");
  fixture("plan.md", "# Plan\n\n## 2. Priority order\n\n1. Ship the widget.\n\n## Revision log\n\n- 2026-01-01 00:00 review\n");
  fixture("decisions.md", "1. Owner 2026-01-01: ship the widget.\n");
  fixture("tasks/T-1.yml", "id: T-1\nstatus: open\nupdated: 2026-01-01\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("titan-factory planner wake", () => {
  it("Unchanged inputs skip the run", async () => {
    const config = writeConfig();
    await wake(config);
    const second = await wake(config);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/skip: inputs unchanged since 2026-01-02T03:00:00.000Z/);
    expect(spawns()).toHaveLength(1);
  });

  it("A changed task queue runs it", async () => {
    const config = writeConfig();
    await wake(config);
    fixture("tasks/T-1.yml", "id: T-1\nstatus: done\nupdated: 2026-01-01\n");
    const second = await wake(config);
    expect(second.out).toMatch(/spawned factory-planner/);
    expect(spawns()).toHaveLength(2);
  });

  it("The fingerprint ignores timestamps-only churn", async () => {
    const config = writeConfig();
    await wake(config);
    fixture("tasks/T-1.yml", "id: T-1\nstatus: open\nupdated: 2026-01-02\n");
    merged = { code: 0, stdout: "101 abc123 2026-01-02T11:30:05.123Z\n" };
    fixture("decisions.md", "1. Owner 2026-01-01: ship the widget.\n");
    const second = await wake(config);
    expect(second.out).toMatch(/skip: inputs unchanged/);
    expect(spawns()).toHaveLength(1);
  });

  it("the planner's own plan edits after a spawn do not run it again, but a later plan edit does", async () => {
    const config = writeConfig();
    await wake(config);
    fixture("plan.md", "# Plan\n\n## 2. Priority order\n\n1. Ship the widget.\n2. Test it.\n");
    expect((await wake(config)).out).toMatch(/skip: inputs unchanged/);
    fixture("plan.md", "# Plan\n\n## 2. Priority order\n\n1. Test the widget first.\n");
    await wake(config);
    expect(spawns()).toHaveLength(2);
  });

  it("spawns on the configured profile in the configured checkout, and --profile overrides it", async () => {
    const config = writeConfig({ profile: "planner-a", configDir: join(dir, "account") });
    await wake(config);
    fixture("decisions.md", "2. Owner: a new decision.\n");
    await wake(config, "--profile", "planner-b");
    const [first, second] = spawns();
    expect(first!.args).toEqual(["agent", "spawn", "factory-planner", "planner-a", "--config-dir", join(dir, "account"), "--role", "planner", "--surface", "headless", "--brief-stdin"]);
    expect(first!.options).toEqual({ input: "You are the planner.\n", cwd: dir });
    expect(second!.args[3]).toBe("planner-b");
  });

  it("a digest input reaches the planner cut to the token budget, with a pointer ahead of the brief", async () => {
    fixture("log.md", `${"old line\n".repeat(50)}${"x".repeat(400)}\n`);
    const config = writeConfig({ digestMaxTokens: 200 }, [{ name: "log", file: join(dir, "log.md"), digest: true, tailLines: 1 }]);
    await wake(config);
    const digest = readFileSync(join(dir, "state", "titan-factory", "planner-wake", "factory-planner-digest.md"), "utf8");
    expect(digest.length).toBeLessThanOrEqual(200);
    expect(digest).not.toContain("old line");
    expect(digest).toMatch(/digest cut at 200 tokens/);
    expect(spawns()[0]!.options!.input).toMatch(/^Your inputs are pre-digested \(at most 200 tokens\) in .*factory-planner-digest\.md/);
  });

  it("an input that cannot be read runs the planner rather than skipping it", async () => {
    const config = writeConfig();
    await wake(config);
    merged = { code: 1, stdout: "" };
    const second = await wake(config);
    expect(second.out).toMatch(/fingerprint unavailable \(merged: exit 1: gh: rate limited\); running/);
    expect(spawns()).toHaveLength(2);
  });

  it("a planner still running is left alone", async () => {
    const busy: PlannerRun = async (file, args, options) => {
      calls.push({ file, args, options });
      return { code: 0, stdout: args[1] === "ls" ? "factory-planner  working  abc\n" : "", stderr: "" };
    };
    let out = "";
    const io: CliIo = { stdout: (text) => void (out += text), stderr: () => {}, env: { XDG_STATE_HOME: join(dir, "state") } };
    await runCli(["planner", "wake", "--config", writeConfig()], io, { workflows: factoryWorkflows, routes: [], planner: { run: busy } });
    expect(out).toMatch(/skip: factory-planner is working/);
    expect(spawns()).toHaveLength(0);
  });
});
