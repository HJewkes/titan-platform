import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { runCli } from "../../cli.js";
import { agentNameFor } from "../../dispatch/plan.js";
import { EXIT } from "../../exit-codes.js";
import { firstPicks, resolveSpawnTask, scopedSpawns, type PickScope } from "./compare-picks.js";
import type { ShadowRowRead, SpawnRead } from "./compare-read.js";
import { renderSection, upsertSection } from "./compare-report.js";
import { compareDay, type CompareReport } from "./compare.js";

const DAY = "2026-03-04";
const FROM = Date.parse(`${DAY}T00:00:00Z`);
const TO = FROM + 86_400_000;
const LANE = { initiative: "zeta", tag: "lane-a" };
const SCOPE: PickScope = { initiatives: new Set(["zeta"]), prefixes: { ZZ: "zeta" } };
const at = (hhmm: string, day = DAY): number => Date.parse(`${day}T${hhmm}:00Z`);

type Judged = Omit<ShadowRowRead, "wake" | "at">;

function wake(id: string, when: number, rows: Judged[]): ShadowRowRead[] {
  const iso = new Date(when).toISOString();
  return [{ kind: "wake", wake: id, at: iso }, ...rows.map((row) => ({ lane: LANE, ...row, wake: id, at: iso }))];
}

const would = (n: number, rank: number, extra: Partial<Judged> = {}): Judged => ({ kind: "would-dispatch", task: `zeta/ZZ-${n}`, rank, bet: "zeta/B1", basis: "selected", ...extra });
const refused = (n: number, codes: string[], stage: string, rank?: number): Judged => ({ kind: "refused", task: `zeta/ZZ-${n}`, codes, stage, ...(rank !== undefined && { rank }) });
const unreadLane: Judged = { kind: "refused", task: null, stage: "admission", codes: ["signal-unreadable"] };

function spawn(ts: number, fields: Partial<SpawnRead> = {}): SpawnRead {
  return { ts, name: null, task: null, role: "worker", briefing: null, ...fields };
}

function score(dayRows: ShadowRowRead[], spawns: SpawnRead[], priorRows: ShadowRowRead[] = []): CompareReport {
  const nearby = scopedSpawns(spawns, SCOPE).picks;
  const { counts } = scopedSpawns(spawns.filter((s) => s.ts >= FROM && s.ts < TO), SCOPE);
  const picks = firstPicks(nearby, [], FROM, TO, SCOPE);
  return compareDay({ day: DAY, lanes: ["zeta/lane-a"], seat: "op-seat", dayRows, priorRows, badLines: 0, picks, nearbyPicks: nearby, counts });
}

describe("compareDay agreement", () => {
  it("an operator spawn on the task ranked 1 at the latest prior wake is in the top K", () => {
    const report = score(wake("w1", at("09:00"), [would(1, 1), would(2, 2)]), [spawn(at("09:10"), { task: "ZZ-1" })]);

    expect(report.agreement).toMatchObject({ inTopK: 1, of: 1, rate: 1, k: 1, rankPctMedian: 0 });
    expect(report.operatorOnly).toEqual([]);
  });

  it("uses the latest wake before the spawn, so a re-rank between wakes changes the verdict", () => {
    const rows = [...wake("w1", at("09:00"), [would(2, 1), would(1, 2)]), ...wake("w2", at("10:00"), [would(1, 1), would(2, 2)])];

    const report = score(rows, [spawn(at("10:30"), { task: "ZZ-1" })]);

    expect(report.agreement.inTopK).toBe(1);
  });

  it("agreement is in-top-K picks over operator picks, K being the day's distinct first dispatches", () => {
    const rows = wake("w1", at("09:00"), [would(1, 1), would(2, 2), refused(3, ["no-bet"], "eligibility")]);

    const report = score(rows, [spawn(at("09:10"), { task: "ZZ-1" }), spawn(at("09:20"), { task: "ZZ-3" })]);

    expect(report.agreement).toMatchObject({ inTopK: 1, of: 2, rate: 0.5, k: 2 });
    expect(report.perLane).toEqual([{ lane: "zeta/lane-a", n: 2, inTopK: 1, rate: 0.5, wouldDispatch: 2 }]);
  });

  it("a spawn just after midnight is judged against the previous day's last wake", () => {
    const report = score([], [spawn(at("00:05"), { task: "ZZ-1" })], wake("w0", at("23:40", "2026-03-03"), [would(1, 1)]));

    expect(report.agreement.inTopK).toBe(1);
  });
});

describe("compareDay operator-only and shadow-only", () => {
  it("a spawn on a refused task is operator-only with the refusal codes and stage", () => {
    const report = score(wake("w1", at("09:00"), [refused(4, ["no-bet", "no-fold"], "eligibility")]), [spawn(at("11:02"), { task: "ZZ-4" })]);

    expect(report.operatorOnly).toEqual([{ task: "zeta/ZZ-4", spawnedAt: "2026-03-04T11:02:00.000Z", shadowVerdict: "refused", codes: ["no-bet", "no-fold"], stage: "eligibility" }]);
  });

  it("a spawn on a task no row names is absent and not in the lane; one before any wake has no prior wake", () => {
    const report = score(wake("w1", at("09:00"), [would(1, 1)]), [spawn(at("08:00"), { task: "ZZ-6" }), spawn(at("09:30"), { task: "ZZ-5" })]);

    expect(report.operatorOnly.map((entry) => [entry.task, entry.shadowVerdict, entry.codes])).toEqual([
      ["zeta/ZZ-6", "absent", ["no-prior-wake"]],
      ["zeta/ZZ-5", "absent", ["not-in-lane"]],
    ]);
  });

  it("a shadow pick with no operator spawn within 24 h is shadow-only; one spawned the next morning is not", () => {
    const rows = wake("w1", at("14:00"), [would(1, 1), would(2, 2)]);

    const report = score(rows, [spawn(at("09:00", "2026-03-05"), { task: "ZZ-2" })]);

    expect(report.shadowOnly).toEqual([{ task: "zeta/ZZ-1", firstPicked: "2026-03-04T14:00:00.000Z", bet: "zeta/B1", basis: "selected" }]);
  });

  it("counts strict and relaxed would-dispatch tasks side by side", () => {
    const rows = wake("w1", at("09:00"), [would(1, 1), would(2, 2, { relaxed: ["bet-field"] })]);

    expect(score(rows, []).strictVsRelaxed).toEqual({ wouldDispatchStrict: 1, wouldDispatchRelaxed: 2 });
  });
});

describe("operator picks", () => {
  it("counts each task once per day at its first spawn, and leaves review, fix-round and planner spawns out", () => {
    const spawns = [
      spawn(at("09:00"), { task: "ZZ-1" }),
      spawn(at("10:00"), { task: "ZZ-1", name: "ops-zz1-s2" }),
      spawn(at("11:00"), { task: "ZZ-2", role: "reviewer" }),
      spawn(at("11:10"), { task: "ZZ-2", role: "fix-round-2" }),
      spawn(at("11:20"), { task: "ZZ-2", role: "planner" }),
      spawn(at("11:30"), { role: "coordinator", name: "op-seat" }),
    ];

    const report = score([], spawns);

    expect(report.operator.spawns).toBe(1);
    expect(report.operator.counts).toEqual({ found: 6, withTask: 5, withoutTask: 1, excludedByRole: 4, unresolved: 0, outOfScope: 0 });
  });

  it("resolves a bare id through meta.briefing, else the prefix map, else leaves it unresolved", () => {
    expect(resolveSpawnTask(spawn(0, { task: "ZZ-9", briefing: "omega" }), SCOPE.prefixes)).toBe("omega/ZZ-9");
    expect(resolveSpawnTask(spawn(0, { task: "ZZ-9" }), SCOPE.prefixes)).toBe("zeta/ZZ-9");
    expect(resolveSpawnTask(spawn(0, { task: "QQ-9" }), SCOPE.prefixes)).toBeNull();
    expect(resolveSpawnTask(spawn(0, { task: "zeta/ZZ-9" }), {})).toBe("zeta/ZZ-9");
  });

  it("a spawn with no meta.task maps through its agentNameFor-style name, sliced or not", () => {
    expect(resolveSpawnTask(spawn(0, { name: agentNameFor("ZZ-123") }), SCOPE.prefixes)).toBe("zeta/ZZ-123");
    expect(resolveSpawnTask(spawn(0, { name: agentNameFor("ZZ-123", "b", "ops") }), SCOPE.prefixes)).toBe("zeta/ZZ-123");
    expect(resolveSpawnTask(spawn(0, { name: "ops-zz77-s2" }), SCOPE.prefixes)).toBe("zeta/ZZ-77");
    expect(resolveSpawnTask(spawn(0, { name: "ops-m1a-sweep" }), SCOPE.prefixes)).toBeNull();
  });

  it("a spawn outside every lane's initiative is counted out of scope, not as a pick", () => {
    const report = score([], [spawn(at("09:00"), { task: "ZZ-1", briefing: "omega" })]);

    expect(report.operator).toMatchObject({ spawns: 0, counts: { outOfScope: 1 } });
  });
});

describe("unreadable days", () => {
  it("a day whose wakes are all signal-unreadable reports no agreement and says so plainly", () => {
    const rows = [...wake("w1", at("09:00"), [unreadLane]), ...wake("w2", at("09:30"), [unreadLane])];

    const report = score(rows, [spawn(at("09:40"), { task: "ZZ-1" })]);

    expect(report).toMatchObject({ wakes: 2, unreadableWakes: 2, agreement: { rate: null } });
    expect(report.operatorOnly[0]).toMatchObject({ shadowVerdict: "absent", codes: ["signal-unreadable"] });
    expect(renderSection(report)).toContain("Shadow could not read the plan store on 2 of 2 wakes: no agreement is reported");
  });
});

describe("COMPARE.md section", () => {
  it("re-running a day replaces its section instead of adding a second", () => {
    const report = score(wake("w1", at("09:00"), [would(1, 1)]), [spawn(at("09:10"), { task: "ZZ-4" })]);
    const other = upsertSection("", "2026-03-03", "## 2026-03-03\n\nearlier\n");

    const once = upsertSection(other, DAY, renderSection(report));
    const twice = upsertSection(once, DAY, renderSection(report));

    expect(twice).toBe(once);
    expect(twice.match(/^## /gm)).toHaveLength(2);
    expect(twice).toContain("earlier");
    expect(once).toContain("Top reason codes for operator-only picks: `not-in-lane` 1");
  });
});

describe("dispatch shadow-compare", () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "shadow-compare-"));
    const shadowDir = join(root, "shadow");
    mkdirSync(shadowDir);
    writeFileSync(join(shadowDir, `${DAY}.jsonl`), wake("w1", at("09:00"), [would(1, 1)]).map((row) => `${JSON.stringify(row)}\n`).join(""));
    const rules = { schema: "titan-dispatcher/v1", mode: "shadow", shadow: { enabled: true, dir: shadowDir }, lanes: [LANE], compare: { operator: "op-seat", prefixes: { ZZ: "zeta" } } };
    writeFileSync(join(root, "dispatcher.json"), JSON.stringify(rules));
    const db = openDatabase(join(root, "events.db"), { foreignKeys: false, wal: false });
    db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)");
    const insert = db.prepare("INSERT INTO events (ts, kind, actor, meta) VALUES (?, 'agent_spawned', ?, ?)");
    insert.run(at("09:10"), "op-seat", JSON.stringify({ task: "ZZ-1", role: "worker" }));
    insert.run(at("09:15"), "someone-else", JSON.stringify({ task: "ZZ-2", launched_by: "op-seat" }));
    db.close();
    return { root, shadowDir };
  }

  async function run(root: string) {
    const out = { stdout: "", stderr: "" };
    const io = { stdout: (t: string) => void (out.stdout += t), stderr: (t: string) => void (out.stderr += t), env: { AGENT_CHAT_HOME: root } };
    const code = await runCli(["dispatch", "shadow-compare", "--day", DAY, "--rule-file", join(root, "dispatcher.json")], io, { workflows: [], routes: [] });
    return { code, ...out };
  }

  it("writes only compare/<day>.json and COMPARE.md, ignores another seat's spawns, and a re-run keeps one section", async () => {
    const { root } = fixture();
    const dbBytes = readFileSync(join(root, "events.db"));

    const first = await run(root);
    await run(root);

    expect(first.code).toBe(EXIT.OK);
    expect(readdirSync(root).sort()).toEqual(["COMPARE.md", "compare", "dispatcher.json", "events.db", "shadow"]);
    expect(readdirSync(join(root, "compare"))).toEqual([`${DAY}.json`]);
    expect(JSON.parse(readFileSync(join(root, "compare", `${DAY}.json`), "utf8"))).toMatchObject({ operator: { spawns: 1 }, agreement: { inTopK: 1, of: 1 } });
    expect(readFileSync(join(root, "COMPARE.md"), "utf8").match(/^## /gm)).toHaveLength(1);
    expect(readFileSync(join(root, "events.db")).equals(dbBytes)).toBe(true);
  });

  it("refuses a missing --day as a usage error", async () => {
    const { root } = fixture();
    const out = { stderr: "" };
    const io = { stdout: () => undefined, stderr: (t: string) => void (out.stderr += t), env: { AGENT_CHAT_HOME: root } };

    expect(await runCli(["dispatch", "shadow-compare", "--rule-file", join(root, "dispatcher.json")], io, { workflows: [], routes: [] })).toBe(EXIT.USAGE);
    expect(out.stderr).toContain("--day");
  });
});
