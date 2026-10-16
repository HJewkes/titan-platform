import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerRowSchema } from "@titan-design/decider";
import { ANSWERS_FILE, createDecisionLog, decisionLine, decisionsClass, type DecisionAnswer, type DecisionItem, type HumanOnly } from "./decision-log.js";

const SEED = "# Decisions\n\n## 41. An earlier numbered item\n\nBody.\n\n## Queue answers 2026-01-01\n\n- 09:00Z a-b: older → A (item q-0, by owner via console)\n";
const DAY = "2026-03-04";
const AT = "2026-03-04T10:15:00.000Z";

let root: string;
let stateDir: string;
let decisionsFile: string;

const ship = (overrides: Partial<DecisionItem> = {}): DecisionItem => ({
  id: "q-ship",
  sources: [{ system: "deposit", ref: "fixture-asker/ship-1" }],
  kind: "approve",
  door: "two-way",
  summary: "Ship the lantern retry fix?",
  options: [
    { id: "ship", label: "Ship" },
    { id: "hold", label: "Hold" },
  ],
  recommended: { optionId: "ship", by: "fixture-agent" },
  keys: ["pr:example/lantern#7"],
  initiative: "orbit-relay",
  personal: false,
  openedAt: "2026-03-04T09:00:00.000Z",
  ...overrides,
});
const abDecide = (overrides: Partial<DecisionItem> = {}) => ship({ id: "q-ab", kind: "decide", summary: "Which cache policy?", keys: [], ...overrides });
const answer = (overrides: Partial<DecisionAnswer> = {}): DecisionAnswer => ({ optionId: "ship", by: { class: "owner", id: "owner", channel: "console" }, at: AT, ...overrides });

const known = (...initiatives: string[]) => async (): Promise<HumanOnly> => ({ known: true, initiatives: new Set(initiatives) });

function makeLog(overrides: Partial<Parameters<typeof createDecisionLog>[0]> = {}) {
  return createDecisionLog({ stateDir, decisionsFile, humanOnly: known("garden-plan"), today: () => DAY, ...overrides });
}

const ledgerPath = () => path.join(stateDir, ANSWERS_FILE);
const ledgerLines = async () => (await readFile(ledgerPath(), "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
const decisions = () => readFile(decisionsFile, "utf8");
const headings = (text: string) => text.split("\n").filter((line) => line.startsWith("## "));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "decision-log-"));
  stateDir = path.join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  decisionsFile = path.join(root, "decisions.md");
  await writeFile(decisionsFile, SEED);
});

afterEach(async () => {
  await chmod(stateDir, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe("decision log", () => {
  it("appends one decider-readable ledger row per answer", async () => {
    const log = makeLog();

    await log.record(ship(), answer());
    await log.record(ship({ id: "q-ship-2" }), answer({ optionId: "hold" }));

    const lines = await ledgerLines();
    expect(lines).toHaveLength(2);
    const rows = lines.map((line) => LedgerRowSchema.parse(JSON.parse(line)));
    expect(rows[0]).toMatchObject({ v: 2, source: "queue", key: `queue:q-ship:${AT}`, answer: "Ship", recommended: "Ship", answered_by: "owner-remote", initiative: "orbit-relay" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ answer: "Hold", item: { id: "q-ship-2", kind: "approve", door: "two-way" }, by: { channel: "console" }, decisions: null });
  });

  it("creates the ledger at mode 0600 and never writes through a symlink at its name", async () => {
    await makeLog().record(ship(), answer());
    expect((await stat(ledgerPath())).mode & 0o777).toBe(0o600);

    await rm(ledgerPath());
    const target = path.join(root, "elsewhere.jsonl");
    // 0600 and ours, so only O_NOFOLLOW (not the fstat checks) stands between the write and the target.
    await writeFile(target, "untouched", { mode: 0o600 });
    await symlink(target, ledgerPath());

    const result = await makeLog().record(ship(), answer());

    expect(result).toMatchObject({ ledger: "failed", reason: "ledger write failed" });
    expect(await readFile(target, "utf8")).toBe("untouched");
  });

  it("refuses an existing ledger other users can read", async () => {
    await writeFile(ledgerPath(), "", { mode: 0o644 });
    await chmod(ledgerPath(), 0o644);

    expect(await makeLog().record(ship(), answer())).toMatchObject({ ledger: "failed" });
    expect(await ledgerLines()).toEqual([]);
  });

  it("writes a decisions bullet only for one-way, A/B and policy answers", async () => {
    const log = makeLog();

    const shipResult = await log.record(ship(), answer());
    expect(shipResult).toEqual({ ledger: "written", decisions: "not-a-decision" });
    expect(await decisions()).toBe(SEED);

    const results = await Promise.all([
      log.record(abDecide(), answer()),
      log.record(ship({ id: "q-oneway", door: "one-way" }), answer()),
      log.record(ship({ id: "q-policy", class: "D12" }), answer()),
    ]);

    expect(results.map((each) => each.decisions)).toEqual(["written", "written", "written"]);
    const added = (await decisions()).slice(SEED.length).split("\n").filter((line) => line.startsWith("- "));
    expect(added).toEqual([
      expect.stringMatching(/^- 10:15Z a-b: Which cache policy\? → Ship \(item q-ab, by owner via console\)$/),
      expect.stringMatching(/^- 10:15Z one-way: .* \(item q-oneway,/),
      expect.stringMatching(/^- 10:15Z policy: .* \(item q-policy,/),
    ]);
    expect(await ledgerLines()).toHaveLength(4);
  });

  it("adds today's heading once, a new heading on a new day, and keeps every earlier byte", async () => {
    let day = DAY;
    const log = makeLog({ today: () => day });

    await log.record(abDecide(), answer());
    await log.record(abDecide({ id: "q-ab-2" }), answer());
    const firstDay = await decisions();
    day = "2026-03-05";
    await log.record(abDecide({ id: "q-ab-3" }), answer());

    const text = await decisions();
    expect(text.startsWith(firstDay)).toBe(true);
    expect(firstDay.startsWith(SEED)).toBe(true);
    expect(headings(text).filter((line) => line.startsWith("## Queue answers"))).toEqual([
      "## Queue answers 2026-01-01",
      `## Queue answers ${DAY}`,
      "## Queue answers 2026-03-05",
    ]);
    expect(text.slice(SEED.length)).toMatch(/^\n## Queue answers 2026-03-04\n\n- .*q-ab,.*\n- .*q-ab-2,.*\n\n## Queue answers 2026-03-05\n\n- .*q-ab-3,.*\n$/);
  });

  it.each([
    ["a personal item", { item: abDecide({ personal: true }), humanOnly: known() }, "personal"],
    ["a human-only initiative", { item: abDecide({ initiative: "garden-plan" }), humanOnly: known("garden-plan") }, "human-only-initiative"],
    ["an unknown human-only list", { item: abDecide(), humanOnly: async (): Promise<HumanOnly> => ({ known: false }) }, "human-only unknown"],
    ["a human-only reader that throws", { item: abDecide(), humanOnly: () => Promise.reject(new Error("down")) }, "human-only unknown"],
  ])("writes nothing for %s (fail closed)", async (_label, { item, humanOnly }, reason) => {
    const result = await makeLog({ humanOnly }).record(item, answer());

    expect(result).toEqual({ ledger: "excluded", decisions: "excluded", reason });
    expect(await ledgerLines()).toEqual([]);
    expect(await decisions()).toBe(SEED);
  });

  it("reports a missing decisions file without creating it, and never throws", async () => {
    await rm(decisionsFile);
    const warnings: unknown[] = [];

    const result = await makeLog({ logger: { warn: (fields) => warnings.push(fields) } }).record(abDecide(), answer());

    expect(result).toEqual({ ledger: "written", decisions: "failed", reason: "decisions file missing" });
    expect(result.reason).not.toContain("/");
    expect(await stat(decisionsFile).then(() => true, () => false)).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it.skipIf(process.getuid?.() === 0)("reports an unwritable state dir as a path-free failure", async () => {
    await chmod(stateDir, 0o500);

    const result = await makeLog().record(abDecide(), answer());

    expect(result).toEqual({ ledger: "failed", decisions: "written", reason: "ledger write failed" });
    expect(result.reason).not.toContain("/");
  });

  it("keeps an injected heading and CR inside one bullet line", async () => {
    await makeLog().record(abDecide(), answer({ text: "fine\n## Fake heading\r\nmore" }));

    const added = (await decisions()).slice(SEED.length);
    expect(added.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
    expect(headings(added)).toEqual([`## Queue answers ${DAY}`]);
    expect(added).not.toContain("\r");
  });

  it("adds one heading for five answers recorded at once on a new day", async () => {
    const log = makeLog();

    await Promise.all([1, 2, 3, 4, 5].map((n) => log.record(abDecide({ id: `q-ab-${n}` }), answer())));

    const added = (await decisions()).slice(SEED.length);
    expect(headings(added)).toEqual([`## Queue answers ${DAY}`]);
    expect(added.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(5);
  });

  it("writes the ledger row alone when no decisions file is configured", async () => {
    const result = await makeLog({ decisionsFile: null }).record(abDecide(), answer());

    expect(result).toEqual({ ledger: "written", decisions: "not-configured" });
    expect(await ledgerLines()).toHaveLength(1);
    expect(await decisions()).toBe(SEED);
  });
});

describe("decisions class and line", () => {
  it("leaves a two-way Ship, a free-text ask and an A/B with no pick out of the decisions file", () => {
    expect(decisionsClass(ship(), answer())).toBeNull();
    expect(decisionsClass(abDecide({ options: undefined }), answer({ optionId: undefined, text: "later" }))).toBeNull();
    expect(decisionsClass(abDecide(), answer({ optionId: undefined, text: "neither" }))).toBeNull();
    expect(decisionsClass(ship({ category: "policy" }), answer())).toBe("policy");
  });

  it("caps a long line at 600 characters with an ellipsis", () => {
    const line = decisionLine(abDecide(), answer({ text: "x".repeat(2000) }));

    expect(line).toHaveLength(600);
    expect(line.endsWith("…")).toBe(true);
  });
});
