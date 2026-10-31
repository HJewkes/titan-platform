import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEvalCli } from "./eval-cli.js";
import { WRITING_METRICS } from "./lint-writing.js";
import { calibrateWriting, formatWritingCheck, metricsOf, parseWritingCheck, windowsOf, WRITING_BUCKETS, type CorpusDoc, type WritingCheck } from "./writing-calibrate.js";
import { loadCorpus, readPrecision, readThresholds } from "./writing-calibrate-cli.js";
import { rowStatus, type RowMetrics, type StatusThresholds } from "./writing-status.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/writing-calibrate/${name}`, import.meta.url));
const shippedPath = fileURLToPath(new URL("../doctrine/writing-check.json", import.meta.url));
const shipped = parseWritingCheck(readFileSync(shippedPath, "utf8"));
const thresholds: StatusThresholds = readThresholds(shippedPath);

function twinCheck(): WritingCheck {
  const { docs, manifestSha256 } = loadCorpus(fixture("corpus-manifest.tsv"));
  return calibrateWriting({ docs, thresholds, precision: readPrecision(fixture("precision.json")), manifestSha256, sourceSha: "synthetic" });
}

describe("the shipped writing-check.json", () => {
  it("each shipped status equals rowStatus of its metrics, in every bucket", () => {
    for (const metric of WRITING_METRICS) {
      for (const { name } of WRITING_BUCKETS) {
        const expected = rowStatus(metricsOf(shipped.rows[metric][name], shipped.precision[metric]), thresholds);
        expect(shipped.statusDetail[metric][name], `${metric} at ${name}`).toEqual(expected);
        expect(shipped.statusByBucket[metric][name], `${metric} at ${name}`).toBe(expected.status);
      }
    }
  });

  it("no row gates at 300-599; neg-synthetic gates at 600-1199; lets drops from 600 words up", () => {
    const at300 = WRITING_METRICS.filter((metric) => shipped.statusByBucket[metric]["300-599"] === "gate");

    expect(at300).toEqual([]);
    expect(shipped.statusByBucket["neg-synthetic"]["600-1199"]).toBe("gate");
    expect(shipped.statusByBucket["second-person"]["300-599"]).toBe("drop");
    expect(shipped.statusByBucket.lets["300-599"]).toBe("report-only");
    expect(shipped.statusByBucket.lets["600-1199"]).toBe("drop");
  });

  it("adjacent-delta warns where it separates ai-other and is report-only where no contrast clears the line", () => {
    expect(shipped.statusByBucket["adjacent-delta"]).toEqual({ "150-299": "report-only", "300-599": "warning", "600-1199": "warning", "1200+": "report-only", full: "warning" });
  });

  it("fits a floor-only row's 10 % band on its low side alone, so no text is flagged for being bursty", () => {
    expect(shipped.band10pct["adjacent-delta"]).toMatchObject({ lo: 0.4861, hi: null });
  });

  it("a punctuation row records that its 17 held-out windows miss the n_neg gate", () => {
    expect(shipped.statusDetail.triads["300-599"].gateMisses).toContain("n_neg 17 < 20");
  });

  it("a human curve rises across the grid in every cell, and says how few windows the punctuation rows have", () => {
    for (const metric of WRITING_METRICS) {
      for (const { name } of WRITING_BUCKETS) {
        const values = shipped.humanQuantiles[metric][name].values ?? [];
        expect(values, `${metric} at ${name}`).toEqual([...values].sort((a, b) => a - b));
        expect(values, `${metric} at ${name}`).toHaveLength(shipped.meta.quantileGrid.length);
      }
    }
    expect(shipped.humanQuantiles.triads["300-599"].n).toBe(17);
    expect(shipped.humanQuantiles.triads["1200+"].n).toBe(4);
    expect(shipped.humanQuantiles.phrases["300-599"].n).toBe(131);
  });

  it("the dailies count as one input among ours-new clusters", () => {
    expect(shipped.rows.phrases.full["ours-new"].auc_heldout?.clustersPos).toBe(8);
  });

  it("window counts carry cluster counts beside them", () => {
    const cell = shipped.rows.phrases["300-599"];

    expect(cell.fpr_heldout.n).toBeGreaterThan(cell.fpr_heldout.clusters);
    expect(cell["ours-new"].auc_heldout?.nPos).toBeGreaterThan(cell["ours-new"].auc_heldout?.clustersPos ?? Infinity);
  });
});

describe("rowStatus", () => {
  const strong = { lo: 0.8, hi: 0.95, nPos: 40 };
  const clean: RowMetrics = { oursNew: strong, aiOther: strong, fpr: { n: 100, point: 0.05, upper: 0.09 }, precision: { correct: 18, labelled: 20 } };

  it("a row meeting every gate condition is a gate", () => {
    expect(rowStatus(clean, thresholds).status).toBe("gate");
  });

  it("a row whose AUC upper bound is under 0.5 on every AI group is dropped", () => {
    const inverted = { lo: 0.3, hi: 0.45, nPos: 40 };

    expect(rowStatus({ ...clean, oursNew: inverted, aiOther: inverted }, thresholds).status).toBe("drop");
  });

  it("a row over the FPR drop line whose every AUC CI spans 0.5 is dropped", () => {
    const chance = { lo: 0.4, hi: 0.6, nPos: 40 };

    expect(rowStatus({ ...clean, oursNew: chance, aiOther: chance, fpr: { n: 100, point: 0.5, upper: 0.6 } }, thresholds).status).toBe("drop");
  });

  it("a row over the gate's FPR point cap stays a warning however narrow its interval", () => {
    const result = rowStatus({ ...clean, fpr: { n: 100, point: 0.12, upper: 0.14 } }, thresholds);

    expect(result.status).toBe("warning");
    expect(result.gateMisses).toEqual(["FPR point 0.12 > 0.10"]);
  });

  it("a row separating only ai-other is a warning, a regression guard", () => {
    expect(rowStatus({ ...clean, oursNew: { lo: 0.45, hi: 0.6, nPos: 40 } }, thresholds).status).toBe("warning");
  });

  it("a row with no measurable numbers is report-only", () => {
    expect(rowStatus({}, thresholds).status).toBe("report-only");
  });
});

describe("held-out human quantiles", () => {
  const talk = (id: string, you: number, set = "human-ontopic"): CorpusDoc => ({
    id, label: "human", set, cluster: `ch:${id}`, tokens: Array.from({ length: 200 }, (_, i) => (i < you ? "you" : "word")),
  });
  // 200 words each, so these say "you" at 0, 5, 10, 15 and 20 per 1k; the 100-per-1k talk is a train text.
  const docs = [talk("a", 0), talk("b", 1), talk("c", 2), talk("d", 3), talk("e", 4), talk("train", 20, "human-creator")];
  const check = (): WritingCheck => calibrateWriting({ docs, thresholds, precision: {}, manifestSha256: "synthetic", sourceSha: "synthetic" });
  const at = (result: WritingCheck, q: number): number | undefined => result.humanQuantiles["second-person"]["150-299"].values?.[result.meta.quantileGrid.indexOf(q)];

  it("interpolates five hand-counted windows at positions 4q, never reading the train text", () => {
    const result = check();

    expect(result.humanQuantiles["second-person"]["150-299"]).toMatchObject({ n: 5, clusters: 5 });
    expect(at(result, 0)).toBe(0);
    expect(at(result, 0.1)).toBe(2);
    expect(at(result, 0.25)).toBe(5);
    expect(at(result, 0.6)).toBe(12);
    expect(at(result, 1)).toBe(20);
  });

  it("a bucket with no held-out window has no curve", () => {
    expect(check().humanQuantiles["second-person"]["300-599"]).toEqual({ n: 0, clusters: 0, values: null });
  });
});

describe("windowsOf", () => {
  const bucket300 = WRITING_BUCKETS[1];
  const tokens = (n: number): string[] => Array.from({ length: n }, (_, i) => `w${i}`);

  it("human windows never exceed 4 per text, however long the text", () => {
    expect(windowsOf(tokens(20_000), bucket300)).toHaveLength(4);
  });

  it("uses a text inside the bucket whole and skips a shorter one", () => {
    expect(windowsOf(tokens(400), bucket300)).toEqual([tokens(400)]);
    expect(windowsOf(tokens(299), bucket300)).toEqual([]);
  });

  it("cuts a longer text into non-overlapping midpoint windows", () => {
    const windows = windowsOf(tokens(1000), bucket300);

    expect(windows.map((window) => window.length)).toEqual([450, 450]);
    expect(new Set(windows.flat()).size).toBe(900);
  });
});

describe("eval writing-calibrate on the synthetic twin", () => {
  it("parity: the synthetic twin gives the metrics the research tool pinned", () => {
    const golden = parseWritingCheck(readFileSync(fixture("golden.json"), "utf8"));
    const check = parseWritingCheck(formatWritingCheck(twinCheck()));

    expect(check.rows).toEqual(golden.rows);
    expect(check.status).toEqual(golden.status);
    expect(check.statusByBucket).toEqual(golden.statusByBucket);
    expect(check.statusDetail).toEqual(golden.statusDetail);
    expect(check.refit5foldByChannel).toEqual(golden.refit5foldByChannel);
    expect(check.band10pct).toEqual(golden.band10pct);
  });

  it("writes numbers only: no text, id or cluster key reaches the output", () => {
    const output = formatWritingCheck(twinCheck());

    for (const leak of ["held-a", "ch:alpha", "input:one", "texts/", "queue"]) expect(output).not.toContain(leak);
  });

  it("the command writes the derived JSON and exits 0", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "writing-calibrate-")), "check.json");

    const code = await runEvalCli(["eval", "writing-calibrate", fixture("corpus-manifest.tsv"), "--precision", fixture("precision.json"), "--source-sha", "synthetic", "--out", out]);

    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(formatWritingCheck(twinCheck()));
  });

  it("a manifest with the wrong header is a usage error", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "writing-calibrate-")), "check.json");

    const code = await runEvalCli(["eval", "writing-calibrate", fixture("precision.json"), "--precision", fixture("precision.json"), "--source-sha", "synthetic", "--out", out]);

    expect(code).toBe(2);
  });
});
