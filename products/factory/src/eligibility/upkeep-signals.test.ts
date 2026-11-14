import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import type { Verbs } from "../cli-types.js";
import type { Runner } from "../dispatch/runner.js";
import { ghApiRead } from "./gh-api-read.js";
import { loadRuleFile } from "./shadow/rule-file.js";
import type { RefusedRow } from "./shadow/row.js";
import { shadowTick } from "./shadow/tick.js";
import { calm, enabledRules, fakeRpc, selectedBet, shadowHome, task } from "./shadow/tick.test-helpers.js";
import { readMergedPrFiles, upkeepProvider, type MergedLanePr } from "./upkeep-signals.js";

const NOW = "2026-11-18T12:00:00Z";

/** A gh that answers `api .../pulls/<n>/files` reads from `files` and throws on anything else, so no test can write. */
function fakeGh(files: Record<number, string[]>, failing: number[] = []): { exec: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Runner = (bin, args) => {
    if (bin !== "gh" || args[0] !== "api" || !args.some((arg) => arg.startsWith("repos/"))) throw new Error(`unexpected ${bin} ${args.join(" ")}`);
    calls.push(args);
    const pr = Number(/pulls\/(\d+)\/files/.exec(args.join(" "))?.[1]);
    if (failing.includes(pr)) return { status: 1, stdout: "" };
    return { status: 0, stdout: (files[pr] ?? []).map((filename) => JSON.stringify({ filename, previous: null })).join("\n") };
  };
  return { exec, calls };
}

const lanePrs = (...prs: number[]): MergedLanePr[] => prs.map((pr) => ({ repo: "acme/app", pr }));

const cacheIn = (): string => join(mkdtempSync(join(tmpdir(), "upkeep-cache-")), "cache", "pr-files.json");

describe("readMergedPrFiles", () => {
  it("asks gh once per PR and answers a second read from the cache with no gh call", () => {
    const gh = fakeGh({ 1: ["products/factory/src/a.ts"], 2: ["apps/console/src/b.tsx"] });
    const cacheFile = cacheIn();

    const first = readMergedPrFiles(lanePrs(1, 2), gh.exec, cacheFile);
    const second = readMergedPrFiles(lanePrs(1, 2), gh.exec, cacheFile);

    expect(gh.calls).toHaveLength(2);
    expect(second).toEqual(first);
    expect(second).toEqual({ ok: true, prs: [{ pr: "acme/app#1", files: ["products/factory/src/a.ts"] }, { pr: "acme/app#2", files: ["apps/console/src/b.tsx"] }] });
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toEqual({ v: 1, files: { "acme/app#1": ["products/factory/src/a.ts"], "acme/app#2": ["apps/console/src/b.tsx"] } });
  });

  it("a PR gh cannot read leaves the share unread, and keeps what it did read for the next wake", () => {
    const gh = fakeGh({ 1: ["scripts/a.mjs"] }, [2]);
    const cacheFile = cacheIn();

    expect(readMergedPrFiles(lanePrs(1, 2), gh.exec, cacheFile)).toEqual({ ok: false, why: "gh could not read the files of acme/app#2" });
    expect(Object.keys(JSON.parse(readFileSync(cacheFile, "utf8")).files)).toEqual(["acme/app#1"]);
  });

  it("a cache that does not parse is rebuilt from gh", () => {
    const gh = fakeGh({ 1: ["scripts/a.mjs"] });
    const cacheFile = cacheIn();
    mkdirSync(dirname(cacheFile));
    writeFileSync(cacheFile, "{not json");

    expect(readMergedPrFiles(lanePrs(1), gh.exec, cacheFile)).toEqual({ ok: true, prs: [{ pr: "acme/app#1", files: ["scripts/a.mjs"] }] });
    expect(gh.calls).toHaveLength(1);
  });
});

describe("ghApiRead", () => {
  it("refuses any bin but gh, any gh verb but api, and any write flag, before a process starts", () => {
    expect(() => ghApiRead("git", ["status"])).toThrow(/runs only gh api/);
    expect(() => ghApiRead("gh", ["pr", "merge", "1"])).toThrow(/runs only gh api/);
    expect(() => ghApiRead("gh", ["api", "-X", "POST", "repos/acme/app/issues"])).toThrow(/refuses -X/);
    expect(() => ghApiRead("gh", ["api", "--method=PATCH", "repos/acme/app/pulls/1"])).toThrow(/refuses --method=PATCH/);
  });
});

/** One lane of AL-1 (upkeep) and AL-2 (product), judged with `exec` over the lane's merged PRs. */
async function tickWith(gh: { exec: Runner }, merged: () => Promise<MergedLanePr[]>) {
  const home = shadowHome();
  writeFileSync(join(home.dir, "dispatcher.json"), JSON.stringify(enabledRules(home)));
  const loaded = loadRuleFile(join(home.dir, "dispatcher.json"))!;
  const rpc = fakeRpc({ tasks: [task(1, { class: "upkeep" }), task(2, { class: "product", created: "2026-11-02" })], bets: [selectedBet(1, 1, ["alpha/AL-1", "alpha/AL-2"])] });
  const verbs = partialFake<Verbs>({ io: { stdout: () => {}, stderr: () => {}, env: home.env }, deps: { workflows: [], routes: [], fetch: rpc.fetch, laneSignals: async () => calm } });
  const since: string[] = [];
  const mergedPrs = async (query: { since: string }) => (since.push(query.since), merged());
  const provider = upkeepProvider({ mergedPrs, exec: gh.exec, now: () => new Date(NOW) });
  const { rows } = await shadowTick({ loaded, verbs, now: new Date(NOW), wake: "w", providers: [provider] });
  return { rows: rows.filter((row): row is RefusedRow => row.kind === "refused"), since, cacheFile: join(home.dir, "cache", "pr-files.json") };
}

describe("upkeep cap in a shadow tick", () => {
  it("holds the upkeep task at stage upkeep with the share's numbers, over PRs merged in the last 7 days, and never the product task", async () => {
    const gh = fakeGh({ 1: ["products/factory/src/a.ts"], 2: ["apps/console/src/b.tsx", "apps/console/src/c.tsx", "apps/console/src/d.tsx"] });

    const { rows, since, cacheFile } = await tickWith(gh, async () => lanePrs(1, 2));

    expect(since).toEqual(["2026-11-11T12:00:00.000Z"]);
    expect(rows.map(({ task, stage, codes, numbers }) => ({ task, stage, codes, numbers }))).toEqual([
      { task: "alpha/AL-1", stage: "upkeep", codes: ["upkeep-cap"], numbers: { upkeepFiles: 1, allFiles: 4, prs: 2, share: 0.25, cap: 0.25 } },
    ]);
    expect(existsSync(cacheFile)).toBe(true);
  });

  it("a merge list that cannot be read holds the upkeep task as unread and asks gh nothing", async () => {
    const gh = fakeGh({});

    const { rows } = await tickWith(gh, async () => {
      throw new Error("factory store locked");
    });

    expect(rows.map(({ task, stage, codes, details }) => ({ task, stage, codes, details }))).toEqual([
      { task: "alpha/AL-1", stage: "upkeep", codes: ["signal-unreadable"], details: ["upkeep share unread: factory store locked"] },
    ]);
    expect(gh.calls).toEqual([]);
  });
});
