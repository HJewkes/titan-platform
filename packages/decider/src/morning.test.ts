import { appendFile, copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSource } from "./extract.js";
import { POLICY } from "./fixtures.js";
import { LedgerRowSchema } from "./ledger.js";
import { initiativesOfTaskIds, joinMorning, morningSource, parseMorningList, parseOwnerAnswers, taskIdsIn, type MorningDayCounts } from "./morning.js";
import { openLedgerStore, type LedgerStore } from "./store.js";

/** The fixture pair is synthetic: invented items in the real files' line shapes. */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "morning");
const ANSWERS = path.join(DIR, "2026-09-30-owner-answers.md");

let store: LedgerStore;

beforeEach(() => {
  store = openLedgerStore(":memory:");
});

async function fixtureJoin() {
  const list = await readFile(path.join(DIR, "2026-09-30.md"), "utf8");
  const answers = await readFile(ANSWERS, "utf8");
  return joinMorning("2026-09-30", list, answers, ANSWERS);
}

describe("morning list parse", () => {
  it("reads bracketed and numbered items and gives a two-id header both ids", () => {
    const items = parseMorningList("[ws-9, A1] **Recommend run: restart it.** body\n   indented\n30. **Lint:** pick one.\n");

    expect(items.map((i) => i.ids)).toEqual([["ws9", "a1"], ["30"]]);
    expect(items[0]?.recommended).toBe("Recommend run: restart it");
    expect(items[1]?.recommended).toBeNull();
  });
});

describe("owner answers parse", () => {
  it("expands a slash list over its prefix and counts a line with no number", () => {
    const parsed = parseOwnerAnswers("# heading\nws9/12: keep\n\nherald: no number\n30 accept\n");

    expect(parsed.answers.map((a) => a.ids)).toEqual([["ws9", "ws12"], ["30"]]);
    expect(parsed.unparseable).toBe(1);
  });
});

describe("morning join over the 2026-09-30 pair", () => {
  it("joins every parseable answer to its item with the right outcome", async () => {
    const { rows } = await fixtureJoin();

    const outcomes = Object.fromEntries(rows.map((r) => [r.key, r.outcome]));
    expect(outcomes).toEqual({
      "morning:2026-09-30/ws4": "accept",
      "morning:2026-09-30/ws9": "accept",
      "morning:2026-09-30/ws12": "accept",
      "morning:2026-09-30/a5": "redirect",
      "morning:2026-09-30/ws20": "redirect",
      "morning:2026-09-30/30": "accept",
      "morning:2026-09-30/34": "accept",
    });
    expect(rows.find((r) => r.key.endsWith("/ws12"))).toMatchObject({
      recommended: "Recommend keep the nightly refresh at 02:00",
      locator: { path: ANSWERS },
    });
  });

  it("counts an unparseable line, an unknown number, a bare number for a prefixed item, a multi-item line and a duplicate", async () => {
    const { counts, rows } = await fixtureJoin();

    expect(counts).toEqual({ unparseable: 1, unmatched: 2, ambiguous: 1, duplicate: 1 });
    expect(rows.map((r) => r.key).filter((k) => /\/(99|12)$/.test(k))).toEqual([]);
    expect(rows.find((r) => r.key.endsWith("/ws4"))?.answer).toBe("yes, archive it");
  });

  it("points each row's locator at the byte its answer line starts on", async () => {
    const { rows } = await fixtureJoin();
    const bytes = await readFile(ANSWERS);

    const row = rows.find((r) => r.key.endsWith("/ws20"));
    expect(bytes.subarray(row?.locator?.byteOffset ?? 0).toString().startsWith("ws20:")).toBe(true);
  });
});

describe("hedged answers", () => {
  const list = "[ws-1] **ws 1. Recommend keep the refresh.** body\n";
  const outcomeOf = (answer: string) => joinMorning("2026-09-30", list, `ws1: ${answer}\n`, "a.md").rows[0]?.outcome;

  it.each(["yes, but hold", "ok, but wait", "keep the refresh but change the hour", "go with B instead"])(
    "does not score %j as accept",
    (answer) => {
      expect(outcomeOf(answer)).not.toBe("accept");
    },
  );

  it.each(["no", "not yet"])("does not score %j as accept", (answer) => {
    expect(outcomeOf(answer)).not.toBe("accept");
  });

  it("still scores a plain yes as accept", () => {
    expect(outcomeOf("yes")).toBe("accept");
  });
});

describe("answer lines naming several items", () => {
  const list = "[ws-1] **Recommend a.**\n[ws-2] **Recommend b.**\n[ws-9] **Recommend c.**\n3. **Recommend d.**\n";
  const join = (answers: string) => joinMorning("2026-09-30", list, answers, "a.md");

  it.each([
    "ws1 and 2: yes",
    "ws1 & 2: yes",
    "ws1 + 2: yes",
    "ws1 and ws2: yes",
    "ws1, ws2: yes",
    "ws1 and 2 yes",
    "1 2: yes",
  ])("counts %j as ambiguous and joins neither item", (line) => {
    const { rows, counts } = join(`${line}\n`);

    expect(rows).toEqual([]);
    expect(counts.ambiguous).toBe(1);
  });

  it("does not join a bare number to a prefixed item", () => {
    const { rows, counts } = join("9 yes\n");

    expect(rows).toEqual([]);
    expect(counts.unmatched).toBe(1);
  });

  it("counts a repeated id and keeps the first answer", () => {
    const { rows, counts } = join("ws1: yes\nws1: no\n");

    expect(rows.map((r) => r.answer)).toEqual(["yes"]);
    expect(counts.duplicate).toBe(1);
  });

  it("writes one row for an item answered under two of its ids and keeps the first", () => {
    const aliased = "[ws-9, A1] **Recommend c.**\n";

    const { rows, counts } = joinMorning("2026-09-30", aliased, "ws9: yes\nA1: no\n", "a.md");

    expect(rows.map((r) => r.answer)).toEqual(["yes"]);
    expect(counts.duplicate).toBe(1);
  });

  it("parses a hyphenated id as the list prints it and joins it", () => {
    const { rows, counts } = join("ws-2: yes\n");

    expect(rows.map((r) => r.key)).toEqual(["morning:2026-09-30/ws2"]);
    expect(counts.unparseable).toBe(0);
  });

  it("still reports an unrelated id as unmatched", () => {
    const { rows, counts } = join("ws-7: yes\n");

    expect(rows).toEqual([]);
    expect(counts.unmatched).toBe(1);
  });
});

describe("morning source", () => {
  function source(onCounts?: (date: string, counts: MorningDayCounts) => void) {
    return morningSource({ dir: DIR, fs: { readdir: (d) => readdir(d), readFile: (f) => readFile(f) }, onCounts });
  }

  it("writes schema-valid rows once and nothing on a second read", async () => {
    const first = await extractSource(store, source(), POLICY);
    const again = await extractSource(store, source(), POLICY);

    expect(first).toMatchObject({ read: 7, written: 7, errors: [] });
    expect(again).toMatchObject({ read: 0, written: 0 });
    for (const row of store.rows()) expect(LedgerRowSchema.safeParse(row).success).toBe(true);
  });

  it("reports the day's counts and applies exclusion to rows", async () => {
    const seen: MorningDayCounts[] = [];
    const policy = { ...POLICY, personalDataPatterns: ["widget service"] };

    const summary = await extractSource(store, source((_, c) => seen.push(c)), policy);

    expect(seen).toEqual([{ unparseable: 1, unmatched: 2, ambiguous: 1, duplicate: 1, unresolved: 7 }]);
    expect(summary.excluded["personal-data"]).toBe(1);
    expect(summary.written).toBe(6);
  });

  it("reports an answers file with no list for its day and writes nothing from it", async () => {
    const fs = { readdir: async () => ["2026-10-01-owner-answers.md"], readFile: async (f: string) => (f.endsWith("-owner-answers.md") ? Buffer.from("1 yes\n") : Promise.reject(new Error("ENOENT"))) };

    const read = await morningSource({ dir: DIR, fs }).read(new Map());

    expect(read.candidates).toEqual([]);
    expect(read.errors).toHaveLength(1);
    expect(read.watermarks.size).toBe(0);
  });
});

describe("morning source over a growing answers file", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "decider-morning-"));
    await copyFile(path.join(DIR, "2026-09-30.md"), path.join(dir, "2026-09-30.md"));
    await copyFile(ANSWERS, path.join(dir, "2026-09-30-owner-answers.md"));
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("emits exactly one new row when one answer line is appended", async () => {
    await extractSource(store, morningSource({ dir }), POLICY);

    await appendFile(path.join(dir, "2026-09-30-owner-answers.md"), "ws34: yes\n");
    const again = await extractSource(store, morningSource({ dir }), POLICY);

    expect(again).toMatchObject({ written: 1, alreadyIndexed: 7 });
  });
});

describe("task ids in text", () => {
  it("lists ids in order without repeats", () => {
    expect(taskIdsIn("see WG-12, then TP-3 and WG-12 again")).toEqual(["WG-12", "TP-3"]);
  });

  it("returns nothing when no id is named", () => {
    expect(taskIdsIn("keep the retry threshold at 5, not wg-1 or ABCDE-9")).toEqual([]);
  });

  it("unions the lookup over every id an item names", () => {
    const lookup = new Map([["WG", ["widgets"]], ["WS", ["workspace", "widgets"]]]);
    const resolve = initiativesOfTaskIds((id) => lookup.get(id.split("-")[0] ?? "") ?? []);

    const item = { ids: ["a"], question: "Recommend X (WG-1, WS-2, QQ-3)", recommended: null };

    expect(resolve(item)).toEqual(["widgets", "workspace"]);
  });
});

describe("morning source resolving initiatives", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "morning-initiatives");
  const prefixes = new Map([["WG", ["widgets"]], ["GD", ["garden-diary"]], ["WS", ["workspace"]]]);
  const resolveInitiatives = initiativesOfTaskIds((id) => prefixes.get(id.split("-")[0] ?? "") ?? []);

  const byKey = () => new Map(store.rows().map((row) => [row.key, row]));

  it("claims a one-initiative row and excludes a human-only mention", async () => {
    const summary = await extractSource(store, morningSource({ dir, resolveInitiatives }), POLICY);

    const rows = byKey();
    expect(summary.excluded["human-only-initiative"]).toBe(1);
    expect(rows.get("morning:2026-10-01/ws12")).toMatchObject({ initiative: "widgets", unclaimed: false, category: "tech_design" });
    expect(rows.has("morning:2026-10-01/ws13")).toBe(false);
  });

  it("stores an item naming two initiatives and an item naming none as unclaimed", async () => {
    await extractSource(store, morningSource({ dir, resolveInitiatives }), POLICY);

    const rows = byKey();
    for (const id of ["ws14", "ws15"]) {
      expect(rows.get(`morning:2026-10-01/${id}`)).toMatchObject({ initiative: null, unclaimed: true, category: "tech_design" });
    }
  });

  it("keeps every row unclaimed with no resolver", async () => {
    const summary = await extractSource(store, morningSource({ dir }), POLICY);

    expect(summary.written).toBe(4);
    expect(store.rows().every((row) => row.initiative === null && row.unclaimed)).toBe(true);
  });

  it("reports unresolved rows to onCounts", async () => {
    const seen: MorningDayCounts[] = [];

    await extractSource(store, morningSource({ dir, resolveInitiatives, onCounts: (_, c) => seen.push(c) }), POLICY);

    expect(seen[0]?.unresolved).toBe(2);
  });

  it("leaves the day unread and reported when the resolver throws", async () => {
    const failing = () => Promise.reject(new Error("no charter"));

    const read = await morningSource({ dir, resolveInitiatives: failing }).read(new Map());

    expect(read.candidates).toEqual([]);
    expect(read.watermarks.size).toBe(0);
    expect(read.errors[0]).toContain("no charter");
  });
});
