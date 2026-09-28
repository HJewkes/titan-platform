import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPrune } from "../prune.js";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import {
  carryForwardVerdicts,
  findingKey,
  hashText,
  keyFindings,
  listFindings,
  listVerdicts,
  saveFindings,
  saveVerdicts,
  type StoredVerdict,
} from "./finding-store.js";
import { externalToFinding, type Finding } from "./findings.js";

const SOURCE = ["def fit(self, robust: bool = False, debug: bool = False):", "    return self._fit(robust)"];

function fbt(line: number, message: string): Finding {
  return externalToFinding({ tool: "ruff", rule: "FBT001", file: "iv/gmm.py", line, message, severity: "warning" });
}

function keyOne(finding: Finding, flaggedText: string, excerptHash?: string): string {
  return keyFindings([{ finding, anchor: "iv/gmm.py#fit", flaggedText, excerptHash }])[0]!.key;
}

function verdict(key: string, excerptHash: string): StoredVerdict {
  return {
    key,
    verdict: "confirmed",
    rationale: "boolean positional flag",
    citations: [{ path: "iv/gmm.py", lineStart: 47, lineEnd: 47, quote: SOURCE[0]! }],
    excerptHash,
    model: "sonnet",
    costUsd: 0.02,
    runId: "run-1",
    provenance: "model",
    controlRun: "ok",
  };
}

describe("findingKey", () => {
  it("keeps the key when a line is inserted above the finding", () => {
    const before = keyOne(fbt(47, "robust"), SOURCE[0]!);
    const after = keyOne(fbt(48, "robust"), SOURCE[0]!);

    expect(fbt(47, "robust").id).not.toBe(fbt(48, "robust").id);
    expect(after).toBe(before);
  });

  it("separates two same-rule findings on one line, whatever the input order", () => {
    const inputs = [
      { finding: fbt(47, "robust"), anchor: "iv/gmm.py#fit", flaggedText: SOURCE[0]! },
      { finding: fbt(47, "debug"), anchor: "iv/gmm.py#fit", flaggedText: SOURCE[0]! },
    ];

    const forward = keyFindings(inputs);
    const reversed = keyFindings([...inputs].reverse());

    expect(new Set(forward.map((f) => f.key)).size).toBe(2);
    expect(forward.map((f) => [f.finding.evidence, f.key])).toEqual(reversed.map((f) => [f.finding.evidence, f.key]));
  });

  it("ignores whitespace changes in the flagged text but not a changed character", () => {
    const finding = fbt(47, "robust");
    const base = findingKey({ finding, flaggedText: SOURCE[0]! });

    expect(findingKey({ finding, flaggedText: `    ${SOURCE[0]!.replace(" ", "   ")}\n` })).toBe(base);
    expect(findingKey({ finding, flaggedText: SOURCE[0]!.replace("robust", "rebust") })).not.toBe(base);
  });
});

describe("finding store", () => {
  let dir: string;
  let store: CodeGraphStore;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), "code-graph-findings-"));
    store = openCodeGraph(path.join(dir, "graph.db"));
  });
  afterEach(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function snapshotWithVerdict(ref: string, excerptHash: string): { id: number; key: string } {
    const id = store.createSnapshot({ ref, indexVersion: "0.1.0" });
    const stored = keyFindings([{ finding: fbt(47, "robust"), flaggedText: SOURCE[0]!, excerptHash }]);
    saveFindings(store, id, stored);
    saveVerdicts(store, id, [verdict(stored[0]!.key, excerptHash)]);
    return { id, key: stored[0]!.key };
  }

  it("round-trips findings and verdicts", () => {
    const { id, key } = snapshotWithVerdict("a", "h1");

    expect(listFindings(store, id)).toEqual([{ key, finding: fbt(47, "robust"), excerptHash: "h1" }]);
    expect(listVerdicts(store, id)).toEqual([verdict(key, "h1")]);
  });

  it("drops a pruned snapshot's findings and verdicts and keeps the other's", () => {
    const old = snapshotWithVerdict("old", "h1");
    const kept = snapshotWithVerdict("new", "h1");

    runPrune(store, { keep: 1 });

    expect(listFindings(store, old.id)).toEqual([]);
    expect(listVerdicts(store, old.id)).toEqual([]);
    expect(listFindings(store, kept.id)).toHaveLength(1);
    expect(listVerdicts(store, kept.id)).toHaveLength(1);
  });

  it("carries a verdict forward when the key and excerpt hash match", () => {
    const from = snapshotWithVerdict("a", hashText("excerpt"));
    const to = store.createSnapshot({ ref: "b", indexVersion: "0.1.0" });
    saveFindings(store, to, keyFindings([{ finding: fbt(52, "robust"), flaggedText: SOURCE[0]!, excerptHash: hashText("excerpt") }]));

    expect(carryForwardVerdicts(store, from.id, to)).toBe(1);
    expect(listVerdicts(store, to)).toEqual([{ ...verdict(from.key, hashText("excerpt")), carriedFrom: from.id }]);
  });

  it("does not carry a verdict when one character of the excerpt around the flagged lines changed", () => {
    const from = snapshotWithVerdict("a", hashText("excerpt"));
    const to = store.createSnapshot({ ref: "b", indexVersion: "0.1.0" });
    saveFindings(store, to, keyFindings([{ finding: fbt(47, "robust"), flaggedText: SOURCE[0]!, excerptHash: hashText("excerpT") }]));

    expect(listFindings(store, to)[0]!.key).toBe(from.key);
    expect(carryForwardVerdicts(store, from.id, to)).toBe(0);
    expect(listVerdicts(store, to)).toEqual([]);
  });

  it("does not carry a verdict when one character of the flagged lines changed", () => {
    const from = snapshotWithVerdict("a", hashText("excerpt"));
    const to = store.createSnapshot({ ref: "b", indexVersion: "0.1.0" });
    const flaggedText = SOURCE[0]!.replace("robust", "rebust");
    saveFindings(store, to, keyFindings([{ finding: fbt(47, "robust"), flaggedText, excerptHash: hashText("excerpt") }]));

    expect(carryForwardVerdicts(store, from.id, to)).toBe(0);
  });

  it("keeps a verdict the target snapshot already holds", () => {
    const from = snapshotWithVerdict("a", "h1");
    const to = snapshotWithVerdict("b", "h1");
    saveVerdicts(store, to.id, [{ ...verdict(to.key, "h1"), verdict: "justified" }]);

    expect(carryForwardVerdicts(store, from.id, to.id)).toBe(0);
    expect(listVerdicts(store, to.id)[0]!.verdict).toBe("justified");
  });
});
