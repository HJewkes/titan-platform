import { appendFile, copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSource } from "./extract.js";
import { POLICY } from "./fixtures.js";
import { LedgerRowSchema } from "./ledger.js";
import { joinMorning, morningSource, parseMorningList, parseOwnerAnswers, type MorningCounts } from "./morning.js";
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

  it.each(["ws1 and 2: yes", "ws1 & 2: yes", "ws1 + 2: yes"])("counts %j as ambiguous and joins neither item", (line) => {
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
});

describe("morning source", () => {
  function source(onCounts?: (date: string, counts: MorningCounts) => void) {
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
    const seen: MorningCounts[] = [];
    const policy = { ...POLICY, personalDataPatterns: ["widget service"] };

    const summary = await extractSource(store, source((_, c) => seen.push(c)), policy);

    expect(seen).toEqual([{ unparseable: 1, unmatched: 2, ambiguous: 1, duplicate: 1 }]);
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

    await appendFile(path.join(dir, "2026-09-30-owner-answers.md"), "A1: yes\n");
    const again = await extractSource(store, morningSource({ dir }), POLICY);

    expect(again).toMatchObject({ written: 1, alreadyIndexed: 7 });
  });
});
