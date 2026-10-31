import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runL0 } from "./eval-l0.js";
import { registerCheck, spokenText } from "./lint-register.js";
import { chapterRefusal, protectedRows } from "./rewrite-pass.js";
import { lint, tour, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";
import { parseWritingCheck } from "./writing-calibrate.js";
import type { WritingStatus } from "./writing-status.js";

// These tests read the shipped doctrine/writing-check.json: what the rewrite and Q-V11 do with each row's status.
const SHIPPED = parseWritingCheck(readFileSync(new URL("../doctrine/writing-check.json", import.meta.url), "utf8"));
const rowsWithStatus = (bucket: "300-599", statuses: readonly WritingStatus[]): string[] =>
  Object.entries(SHIPPED.statusByBucket).filter(([, byBucket]) => statuses.includes(byBucket[bucket])).map(([row]) => row);

const THESIS_IDS = ["h1", "w4", "c1"];
const beats = (...spoken: string[]): BeatSpec[] => spoken.map((line, i) => [THESIS_IDS[i] ?? `b${i}`, "ch1", "WHAT", line]);
const script = (...spoken: string[]) => tour(beats(...spoken));
const wordsOf = (spoken: readonly string[]): number => spokenText(spoken).words.length;

// Ten words with no number, pronoun, contraction or device in them.
const FILLER = "The queue moves each job to the next free worker.";
const filler = (n: number): string[] => Array.from({ length: n }, () => FILLER);
const TRIAD = "It reads the scan, checks the row and prints the label.";
const NO_X = "No clerk retypes the rows.";
const STOCK = "The desk stays calm.";

describe("Q-V11 rows follow the status table at the script's own length", () => {
  it("never warns on a row that is report-only or dropped at 300-599 words, however far out of band", () => {
    const spoken = [...filler(44), "It stops; it starts; it stops.", NO_X, NO_X];
    const quiet = rowsWithStatus("300-599", ["report-only", "drop"]);

    const rows = lint(script(...spoken), [registerCheck]);

    expect(wordsOf(spoken)).toBeGreaterThanOrEqual(300);
    expect(quiet).toEqual(expect.arrayContaining(["semicolons", "second-person", "contractions", "lets"]));
    expect(quiet.filter((row) => rows.get(`register:${row}`)?.pass === false)).toEqual([]);
    expect(rows.get("register:semicolons")?.value).toBeGreaterThan(0.6);
    expect(rows.get("register:neg-synthetic")).toMatchObject({ pass: false, threshold: 2.5 });
  });

  it("reports a \"no X\" without warning at 150-299 words, where neg-synthetic is report-only", () => {
    const spoken = [...filler(20), NO_X, NO_X];

    const row = lint(script(...spoken), [registerCheck]).get("register:neg-synthetic");

    expect(SHIPPED.statusByBucket["neg-synthetic"]["150-299"]).toBe("report-only");
    expect(row?.value).toBeGreaterThan(2.5);
    expect(row?.pass).toBe(true);
  });
});

describe("protectedRows", () => {
  it("protects phrases, neg-synthetic and downtoners at 300-599 words and leaves lets and contractions out", () => {
    const guarded = protectedRows(450);

    expect([...guarded]).toEqual(expect.arrayContaining(["register:phrases", "register:neg-synthetic", "register:downtoners"]));
    expect(guarded.has("register:lets")).toBe(false);
    expect(guarded.has("register:contractions")).toBe(false);
  });

  it("never protects lets, which is report-only or dropped at every length", () => {
    expect([225, 450, 900, 1500].filter((words) => protectedRows(words).has("register:lets"))).toEqual([]);
  });

  it("never protects a rewrite target, which the pass already holds", () => {
    expect([...protectedRows(450)].filter((id) => id === "register:triads" || id === "register:numbers-per-beat")).toEqual([]);
  });

  it("protects nothing under 150 words, where no row warns", () => {
    expect(protectedRows(120).size).toBe(0);
  });
});

describe("chapterRefusal with the shipped protections", () => {
  it("reverts a chapter that adds a \"no X\" as a protected row turned red, though it cuts a triad", () => {
    const before = [...filler(43), TRIAD, TRIAD, NO_X];
    const after = [...filler(43), TRIAD, "It reads the scan and prints the label.", NO_X, NO_X];

    const refusal = chapterRefusal(runL0(script(...before)), runL0(script(...after)), protectedRows(wordsOf(before)));

    expect(refusal).toEqual({ why: "a protected row turned red", rows: ["register:neg-synthetic"] });
  });

  it("keeps a chapter that only cuts a stock phrase while the phrases row fails", () => {
    const before = [...filler(40), STOCK, STOCK, STOCK];
    const after = [...filler(40), STOCK, STOCK, "The desk is quiet."];
    const rowsBefore = runL0(script(...before));

    const refusal = chapterRefusal(rowsBefore, runL0(script(...after)), protectedRows(wordsOf(before)));

    expect(rowsBefore.find((row) => row.check_id === "register:phrases")?.pass).toBe(false);
    expect(refusal).toBeUndefined();
  });
});
