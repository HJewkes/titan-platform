import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EXIT, runCli } from "../../cli.js";
import { betLines, DIGEST, sheetText } from "./bet-sheet.test-helpers.js";

/*
 * `dispatch sheets check|import` (TP-5755 S7). The rpc fake answers only the commands the importer and the tick may
 * call and throws on anything else, so a call to any other command, a select above all, fails the test.
 */

const ALLOWED = [/^plan\.bet\.add$/, /^plan\.outcome\.add$/, /^plan\.[a-z-]+\.list$/, /^task\.list$/];

interface Recorded {
  command: string;
  args: Record<string, unknown>;
}

function recordingRpc(mode: "served" | "unknown" = "served", existing: { outcomes?: unknown[]; bets?: unknown[] } = {}) {
  const calls: Recorded[] = [];
  const fetch = (async (url, init) => {
    const command = String(url).split("/rpc/")[1]!;
    if (!ALLOWED.some((allowed) => allowed.test(command))) throw new Error(`the importer may not call ${command}`);
    calls.push({ command, args: z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body))) });
    if (mode === "unknown") return new Response(JSON.stringify({ ok: false, error: `Unknown command: ${command}`, code: 64 }), { status: 404 });
    if (command === "plan.outcome.list") return new Response(JSON.stringify({ ok: true, data: existing.outcomes ?? [] }));
    if (command === "plan.bet.list") return new Response(JSON.stringify({ ok: true, data: (existing.bets ?? []).filter((bet) => z.object({ state: z.string() }).parse(bet).state === z.object({ state: z.string() }).parse(JSON.parse(String(init?.body))).state) }));
    return new Response(JSON.stringify({ ok: true, data: {} }));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function sheetHome(sheet = sheetText({ bets: [betLines("S1", 1), betLines("S2", 2, { tasks: "[]" })] })) {
  const dir = mkdtempSync(join(tmpdir(), "bet-sheets-"));
  const sheetDir = join(dir, "bets");
  mkdirSync(sheetDir);
  mkdirSync(join(dir, "digests"));
  mkdirSync(join(sheetDir, "prose"));
  writeFileSync(join(sheetDir, "web.md"), sheet);
  writeFileSync(join(sheetDir, "prose", "web.md"), "the prose record is not a sheet");
  writeFileSync(join(dir, "digests", "web.md"), DIGEST);
  writeFileSync(join(dir, "config.json"), "{}");
  return { dir, sheetDir, activeRoot: join(dir, "active"), env: { TITAN_FACTORY_CONFIG: join(dir, "config.json"), ACTIVE_ROOT: join(dir, "active") } };
}

async function sheetsCli(home: ReturnType<typeof sheetHome>, args: string[], fetch = recordingRpc().fetch) {
  const out = { stdout: "", stderr: "" };
  const io = { stdout: (text: string) => void (out.stdout += text), stderr: (text: string) => void (out.stderr += text), env: home.env };
  const code = await runCli(["dispatch", "sheets", ...args], io, { workflows: [], routes: [], fetch });
  return { code, ...out };
}

describe("dispatch sheets check", () => {
  it("prints one ok line per sheet with its bet and task counts, skipping subdirectories", async () => {
    const home = sheetHome();

    const { code, stdout } = await sheetsCli(home, ["check", "--dir", home.sheetDir]);

    expect(code).toBe(EXIT.OK);
    expect(stdout).toBe("ok   web.md: 2 bets, 2 tasks (lane lane-a, week 2026-W47)\n");
  });

  it("prints each error with its line and exits non-zero", async () => {
    const home = sheetHome(sheetText({ bets: [betLines("S1", 1, { cites: "[{ intent_ref: web/I9, quote_ref: msg:ccc333 }]" })] }));

    const { code, stdout } = await sheetsCli(home, ["check", "--dir", home.sheetDir]);

    expect(code).toBe(EXIT.REFUSED);
    expect(stdout).toMatch(/^FAIL web\.md:\d+: bet S1 cites web\/I9, which is not in digest web\n/);
  });

  it("finds the sheets through the rule file's bets.sheetDir", async () => {
    const home = sheetHome();
    const rules = { schema: "titan-dispatcher/v1", mode: "shadow", bets: { source: "selected-then-sheet", sheetDir: home.sheetDir } };
    writeFileSync(join(home.dir, "rules.json"), JSON.stringify(rules));

    const { code, stdout } = await sheetsCli(home, ["check", "--rule-file", join(home.dir, "rules.json")]);

    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("ok   web.md: 2 bets");
  });
});

describe("dispatch sheets import", () => {
  it("--dry-run prints the planned adds and makes no rpc call", async () => {
    const home = sheetHome();
    const rpc = recordingRpc();

    const { code, stdout } = await sheetsCli(home, ["import", "--dry-run", "--dir", home.sheetDir], rpc.fetch);

    expect(code).toBe(EXIT.OK);
    expect(rpc.calls).toEqual([]);
    expect(stdout.split("\n").filter(Boolean).map((line) => line.split(" {")[0])).toEqual(["would call plan.outcome.add", "would call plan.bet.add", "would call plan.bet.add"]);
  });

  it("--apply writes the draft outcome then each proposed bet, through the two adds only", async () => {
    const home = sheetHome();
    const rpc = recordingRpc();

    const { code } = await sheetsCli(home, ["import", "--apply", "--dir", home.sheetDir], rpc.fetch);

    expect(code).toBe(EXIT.OK);
    expect(rpc.calls.filter((call) => call.command.endsWith(".add"))).toEqual([
      { command: "plan.outcome.add", args: { initiative: "alpha", slug: "phone-first", statement: "The page answers from a phone", measure: "terminal scripts per week", intent_ref: "web/I1", quote_ref: "msg:aaa111" } },
      { command: "plan.bet.add", args: expect.objectContaining({ outcome: "alpha/phone-first", week: "2026-W47", order: 1, task: ["alpha/AL-1", "alpha/AL-2"], metric: "list_p50_s", baseline: 8.4 }) },
      { command: "plan.bet.add", args: expect.objectContaining({ order: 2, task: [] }) },
    ]);
  });

  it("--apply on an already-imported sheet skips the outcome and every bet and writes nothing", async () => {
    const home = sheetHome();
    const existing = {
      outcomes: [{ id: "alpha/phone-first" }],
      bets: [
        { outcome: "alpha/phone-first", week: "2026-W47", order: 1, state: "proposed" },
        { outcome: "alpha/phone-first", week: "2026-W47", order: 2, state: "selected" },
      ],
    };
    const rpc = recordingRpc("served", existing);

    const { code, stdout } = await sheetsCli(home, ["import", "--apply", "--dir", home.sheetDir], rpc.fetch);

    expect(code).toBe(EXIT.OK);
    expect(rpc.calls.filter((call) => call.command.endsWith(".add"))).toEqual([]);
    expect(stdout).toContain("imported 0 record(s)");
    expect(stdout).toContain("skipped 3 existing");
  });

  it("--apply does not add back a bet the owner dropped or finished", async () => {
    const home = sheetHome();
    const bets = [
      { outcome: "alpha/phone-first", week: "2026-W47", order: 1, state: "dropped" },
      { outcome: "alpha/phone-first", week: "2026-W47", order: 2, state: "done" },
    ];
    const rpc = recordingRpc("served", { outcomes: [{ id: "alpha/phone-first" }], bets });

    const { code } = await sheetsCli(home, ["import", "--apply", "--dir", home.sheetDir], rpc.fetch);

    expect(code).toBe(EXIT.OK);
    expect(rpc.calls.filter((call) => call.command.endsWith(".add"))).toEqual([]);
  });

  it("--apply on a partly-imported sheet writes only the missing bet", async () => {
    const home = sheetHome();
    const rpc = recordingRpc("served", { outcomes: [{ id: "alpha/phone-first" }], bets: [{ outcome: "alpha/phone-first", week: "2026-W47", order: 1, state: "proposed" }] });

    const { code } = await sheetsCli(home, ["import", "--apply", "--dir", home.sheetDir], rpc.fetch);

    expect(code).toBe(EXIT.OK);
    const adds = rpc.calls.filter((call) => call.command.endsWith(".add"));
    expect(adds).toEqual([{ command: "plan.bet.add", args: expect.objectContaining({ order: 2 }) }]);
  });

  it("--apply against a daemon without the plan commands exits unavailable and writes no plan file itself", async () => {
    const home = sheetHome();
    const rpc = recordingRpc("unknown");

    const { code, stderr } = await sheetsCli(home, ["import", "--apply", "--dir", home.sheetDir], rpc.fetch);

    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(stderr).toContain("active-work has no plan.outcome.list command");
    expect(rpc.calls.map((call) => call.command).filter((command) => command.endsWith(".add"))).toEqual([]);
    expect(existsSync(home.activeRoot)).toBe(false);
  });

  it("names the command that was unknown, not the first call of the plan", async () => {
    const home = sheetHome();
    const rpc = recordingRpc("served", { outcomes: [{ id: "alpha/phone-first" }] });
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (!String(url).endsWith("/plan.bet.add")) return rpc.fetch(url, init);
      return new Response(JSON.stringify({ ok: false, error: "Unknown command: plan.bet.add", code: 64 }), { status: 404 });
    };

    const { code, stderr } = await sheetsCli(home, ["import", "--apply", "--dir", home.sheetDir], fetch);

    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(stderr).toContain("active-work has no plan.bet.add command");
  });

  it("refuses to import a bet whose baseline is still unknown, and calls nothing", async () => {
    const home = sheetHome(sheetText({ bets: [betLines("S1", 1, { prediction: "{ metric: m, direction: increase, baseline: null, expected: 1, read_by: 2026-11-28 }" })] }));
    const rpc = recordingRpc();

    const { code, stderr } = await sheetsCli(home, ["import", "--apply", "--dir", home.sheetDir], rpc.fetch);

    expect(code).toBe(EXIT.REFUSED);
    expect(stderr).toContain("bet S1: plan.bet.add needs a numeric baseline");
    expect(rpc.calls).toEqual([]);
  });

  it("needs exactly one of --dry-run and --apply", async () => {
    const home = sheetHome();

    expect((await sheetsCli(home, ["import", "--dir", home.sheetDir])).code).toBe(EXIT.USAGE);
    expect((await sheetsCli(home, ["import", "--dry-run", "--apply", "--dir", home.sheetDir])).code).toBe(EXIT.USAGE);
  });
});

describe("the sheets code", () => {
  it("has no path to selecting a bet: no source under sheets/ names the owner's select operation", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(dir).filter((file) => file.endsWith(".ts") && !/\.test(-helpers)?\.ts$/.test(file));

    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) expect(readFileSync(join(dir, file), "utf8")).not.toMatch(/plan[-.]bet[-.]select/i);
  });
});
