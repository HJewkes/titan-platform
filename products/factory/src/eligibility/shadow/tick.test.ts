import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../../cli.js";
import type { Verbs } from "../../cli-types.js";
import type { HoldProvider } from "./providers.js";
import type { LoadedRules } from "./rule-file.js";
import { shadowTick } from "./tick.js";
import { calm, enabledRules, fakeRpc, readRows, selectedBet, shadowHome, shadowTickCli, task } from "./tick.test-helpers.js";

const NOW = "2026-11-18T12:00:00Z";

const twoReady = () => fakeRpc({ tasks: [task(1), task(2), task(3, { bet: undefined })], bets: [selectedBet(1, 1, ["alpha/AL-1", "alpha/AL-2"])] });

describe("dispatch shadow-tick", () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(NOW) }));
  afterEach(() => void vi.useRealTimers());

  it("an absent rule file prints disabled, reads nothing and writes nothing", async () => {
    const home = shadowHome();
    const rpc = twoReady();

    const { code, stdout } = await shadowTickCli(home, rpc.fetch);

    expect([code, stdout]).toEqual([EXIT.OK, "dispatcher shadow disabled\n"]);
    expect(rpc.commands).toEqual([]);
    expect(readRows(home.shadowDir)).toEqual([]);
  });

  it("a rule file with shadow off prints disabled and writes nothing", async () => {
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify({ ...enabledRules(home), shadow: { enabled: false, dir: home.shadowDir } }));

    const { code, stdout } = await shadowTickCli(home, twoReady().fetch);

    expect([code, stdout]).toEqual([EXIT.OK, "dispatcher shadow disabled\n"]);
    expect(readRows(home.shadowDir)).toEqual([]);
  });

  it("writes one wake row, would-dispatch rows in dispatch order up to the free slots, and a refused row per refused task", async () => {
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));

    const { code, stdout } = await shadowTickCli(home, twoReady().fetch, { openPrs: 1 });

    expect(code).toBe(EXIT.OK);
    expect(stdout).toMatch(/^dispatcher shadow wake 2026-11-18T12:00:00Z#[0-9a-f]{4}: 2 would-dispatch, 1 refused -> .*2026-11-18\.jsonl\n$/);
    const [day] = readRows(home.shadowDir);
    expect(day?.file).toBe("2026-11-18.jsonl");
    expect(day?.rows[0]).toMatchObject({ v: 1, kind: "wake", at: "2026-11-18T12:00:00.000Z", lanes: 1, rule_hash: expect.stringMatching(/^sha256:/) });
    expect(day?.rows.slice(1).map((row) => [row.kind, row.task, row.codes ?? row.slot])).toEqual([
      ["refused", "alpha/AL-3", ["no-bet"]],
      ["would-dispatch", "alpha/AL-1", 1],
      ["would-dispatch", "alpha/AL-2", 2],
    ]);
    expect(day?.rows[2]).toMatchObject({ lane: { initiative: "alpha", tag: "lane-a" }, week: "2026-W47", basis: "selected", bet: "alpha/B1", rank: 1, free: 2 });
  });

  it("counts merged-not-deployed PRs against the free slots, refusing the task past them", async () => {
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));

    await shadowTickCli(home, twoReady().fetch, { openPrs: 1, mergedNotDeployed: 1 });

    const rows = readRows(home.shadowDir)[0]!.rows.filter((row) => row.stage !== "eligibility" && row.kind !== "wake");
    expect(rows.map((row) => [row.kind, row.task])).toEqual([
      ["would-dispatch", "alpha/AL-1"],
      ["refused", "alpha/AL-2"],
    ]);
    expect(rows[1]).toMatchObject({ stage: "admission", rank: 2, codes: ["lane-open-prs"], numbers: { open: 1, mergedNotDeployed: 1, limit: 3, free: 1 } });
  });

  it("a held lane holds every eligible task with the hold codes and would dispatch none", async () => {
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));

    await shadowTickCli(home, twoReady().fetch, { openPrs: 3 });

    const rows = readRows(home.shadowDir)[0]!.rows.filter((row) => row.stage === "admission");
    expect(rows.map((row) => [row.task, row.codes])).toEqual([
      ["alpha/AL-1", ["lane-open-prs"]],
      ["alpha/AL-2", ["lane-open-prs"]],
    ]);
    expect(readRows(home.shadowDir)[0]!.rows.some((row) => row.kind === "would-dispatch")).toBe(false);
  });

  it("a held lane with no candidate still writes one refused row with a null task", async () => {
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));

    await shadowTickCli(home, fakeRpc({ tasks: [], bets: [] }).fetch, { reviewers: { accounts: 1, exhausted: 1 } });

    expect(readRows(home.shadowDir)[0]!.rows.slice(1)).toEqual([expect.objectContaining({ kind: "refused", task: null, stage: "admission", codes: ["reviewer-limit"] })]);
  });

  it("an unread signal fails closed: no would-dispatch, each task held as signal-unreadable", async () => {
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));

    await shadowTickCli(home, twoReady().fetch, { openPrs: undefined, unread: { openPrs: "store locked" } });

    const rows = readRows(home.shadowDir)[0]!.rows;
    expect(rows.some((row) => row.kind === "would-dispatch")).toBe(false);
    expect(rows.filter((row) => row.stage === "admission").map((row) => row.codes)).toEqual([["signal-unreadable"], ["signal-unreadable"]]);
  });

  it("active-work down writes the wake and one fail-closed lane row, and exits 69", async () => {
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const { code } = await shadowTickCli(home, down);

    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(readRows(home.shadowDir)[0]!.rows.map((row) => [row.kind, row.task ?? null, row.codes ?? null])).toEqual([
      ["wake", null, null],
      ["refused", null, ["signal-unreadable"]],
    ]);
  });

  it("two wakes append to the same day file, and a wake after UTC midnight starts the next", async () => {
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));
    const rpc = fakeRpc({ tasks: [], bets: [] });

    await shadowTickCli(home, rpc.fetch);
    await shadowTickCli(home, rpc.fetch);
    vi.setSystemTime(Date.parse("2026-11-19T00:00:01Z"));
    await shadowTickCli(home, rpc.fetch);

    expect(readRows(home.shadowDir).map(({ file, rows }) => [file, rows.filter((row) => row.kind === "wake").length])).toEqual([
      ["2026-11-18.jsonl", 2],
      ["2026-11-19.jsonl", 1],
    ]);
  });

  it("honours --rule-file over the default path", async () => {
    const home = shadowHome();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "rule-elsewhere-")), "rules.json");
    writeFileSync(elsewhere, JSON.stringify(enabledRules(home)));

    const { code } = await shadowTickCli(home, fakeRpc({ tasks: [], bets: [] }).fetch, {}, ["--rule-file", elsewhere]);

    expect(code).toBe(EXIT.OK);
    expect(readRows(home.shadowDir)).toHaveLength(1);
  });

  it("a rule file that does not parse is a usage error and writes nothing", async () => {
    const home = shadowHome();
    writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify({ ...enabledRules(home), mode: "live" }));

    const { code, stderr } = await shadowTickCli(home, twoReady().fetch);

    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain("mode");
    expect(readRows(home.shadowDir)).toEqual([]);
  });
});

describe("shadowTick hold providers", () => {
  const loaded = (dir: string): LoadedRules => ({ rules: { schema: "titan-dispatcher/v1", mode: "shadow", shadow: { enabled: true, dir }, lanes: [{ initiative: "alpha", tag: "lane-a" }], relax: [], intake: { minSeverity: "medium", expireDays: 28 } }, hash: "sha256:0" });
  const verbs = (fetch: typeof globalThis.fetch, env: NodeJS.ProcessEnv) => partialFake<Verbs>({ io: { stdout: () => {}, stderr: () => {}, env }, deps: { workflows: [], routes: [], fetch, laneSignals: async () => calm } });

  it("a provider hold keeps its task back at the provider's stage, and a throwing provider holds every task", async () => {
    const home = shadowHome();
    const stop: HoldProvider = async () => ({ holds: [{ task: "alpha/AL-1", stage: "stop", codes: ["synthetic-stop"] }] });
    const broken: HoldProvider = async () => {
      throw new Error("store unreadable");
    };
    const input = { loaded: loaded(home.shadowDir), verbs: verbs(twoReady().fetch, home.env), now: new Date(NOW), wake: "w" };

    const held = await shadowTick({ ...input, providers: [stop] });
    const failed = await shadowTick({ ...input, providers: [broken] });

    expect(held.rows.filter((row) => row.kind !== "wake" && row.task !== "alpha/AL-3").map((row) => [row.kind, row.kind === "refused" && row.stage])).toEqual([
      ["refused", "stop"],
      ["would-dispatch", false],
    ]);
    expect(failed.rows.filter((row) => row.kind === "refused" && row.stage === "admission").map((row) => row.kind === "refused" && row.codes)).toEqual([["signal-unreadable"], ["signal-unreadable"]]);
  });
});
