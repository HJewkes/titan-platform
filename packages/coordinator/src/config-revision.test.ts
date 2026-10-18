import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyEdit,
  diffDocuments,
  documentSha,
  revisionSha,
  verifyChain,
  type ConfigRevision,
} from "./config-revision.js";
import type { CoordinatorConfig } from "./coordinator-config.js";

const examplePath = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "single-seat.json");

function exampleDocument(): CoordinatorConfig {
  return JSON.parse(readFileSync(examplePath, "utf8")) as CoordinatorConfig;
}

function edited(doc: CoordinatorConfig, path: string, value: unknown): CoordinatorConfig {
  const result = applyEdit(doc, path, value);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.document;
}

function revision(rev: number, parent: ConfigRevision | null, document: CoordinatorConfig): ConfigRevision {
  return {
    $schema: "titan-coordinator-revision/v1",
    rev,
    parent: parent === null ? null : revisionSha(parent),
    at: `2026-01-0${rev + 1}T00:00:00Z`,
    by: rev === 0 ? { class: "import", id: "importer" } : { class: "owner-remote", id: "console" },
    document,
  };
}

function threeRevisions(): ConfigRevision[] {
  const rev0 = revision(0, null, exampleDocument());
  const rev1 = revision(1, rev0, edited(rev0.document, "seats.operator.concurrency.planners", 2));
  const rev2 = revision(2, rev1, edited(rev1.document, "limits.pools.main.ceiling_five_hour", 80));
  return [rev0, rev1, rev2];
}

describe("applyEdit", () => {
  it("sets a declared field on a copy and leaves the input alone", () => {
    const doc = exampleDocument();
    const result = applyEdit(doc, "seats.operator.concurrency.implementers", 3);
    expect(result.ok && result.document.seats.operator!.concurrency.implementers).toBe(3);
    expect(doc.seats.operator!.concurrency.implementers).toBe(0);
  });

  it("refuses a path the schema does not declare, even where the object is loose", () => {
    const result = applyEdit(exampleDocument(), "seats.operator.concurrency.wizards", 1);
    expect(result).toEqual({
      ok: false,
      errors: [expect.objectContaining({ path: "seats.operator.concurrency.wizards" })],
    });
  });

  it("refuses an unknown top-level key", () => {
    expect(applyEdit(exampleDocument(), "later", 1).ok).toBe(false);
  });

  it("refuses a prototype key", () => {
    expect(applyEdit(exampleDocument(), "seats.__proto__.prefix", "x").ok).toBe(false);
  });

  it("refuses to create a seat that is absent", () => {
    expect(applyEdit(exampleDocument(), "seats.ghost.concurrency.implementers", 1).ok).toBe(false);
  });

  it("refuses a value that breaks the schema or a cross-reference", () => {
    expect(applyEdit(exampleDocument(), "seats.operator.concurrency.implementers", -1).ok).toBe(false);
    const result = applyEdit(exampleDocument(), "seats.operator.pool", "elsewhere");
    expect(result.ok ? [] : result.errors.map((e) => e.path)).toEqual(["seats.operator.pool"]);
  });
});

describe("diffDocuments", () => {
  it("lists each changed leaf with its dotted path, in key order", () => {
    const before = exampleDocument();
    const after = edited(edited(before, "seats.operator.spend.per_day_points", 30), "owner.digest_at", ["09:00"]);
    expect(diffDocuments(before, after)).toEqual([
      { path: "owner.digest_at", kind: "changed", before: ["08:00", "18:00"], after: ["09:00"] },
      { path: "seats.operator.spend.per_day_points", kind: "changed", before: 20, after: 30 },
    ]);
  });

  it("names added and removed keys", () => {
    expect(diffDocuments({ a: 1 }, { b: 2 })).toEqual([
      { path: "a", kind: "removed", before: 1 },
      { path: "b", kind: "added", after: 2 },
    ]);
  });

  it("is empty for the same document with its keys in another order", () => {
    expect(diffDocuments({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toEqual([]);
    expect(documentSha({ a: 1, b: 2 })).toBe(documentSha({ b: 2, a: 1 }));
  });
});

describe("verifyChain", () => {
  it("accepts a linear chain and returns its head", () => {
    const chain = threeRevisions();
    const result = verifyChain(chain);
    expect(result.ok && result.head.rev).toBe(2);
  });

  it("refuses a fork: rev 2 names rev 0 as its parent", () => {
    const [rev0, rev1] = threeRevisions();
    const forked = revision(2, rev0!, edited(rev1!.document, "limits.pools.main.ceiling_five_hour", 80));
    const result = verifyChain([rev0, rev1, forked]);
    expect(result.ok ? [] : result.errors.map((e) => [e.rev, e.code])).toEqual([[2, "parent"]]);
  });

  it("refuses a revision edited after its child named it", () => {
    const chain = threeRevisions();
    chain[1]!.document.seats.operator!.concurrency.implementers = 9;
    const result = verifyChain(chain);
    expect(result.ok ? [] : result.errors.map((e) => [e.rev, e.code])).toEqual([[2, "parent"]]);
  });

  it("refuses a gap in the numbering and a rev 0 with a parent", () => {
    const [rev0, rev1] = threeRevisions();
    const renumbered = { ...rev1!, rev: 5 };
    expect(verifyChain([rev0, renumbered]).ok).toBe(false);
    expect(verifyChain([{ ...rev0!, parent: revisionSha(rev1) }]).ok).toBe(false);
  });

  it("refuses a revision whose document fails the cross-reference check", () => {
    const rev0 = revision(0, null, { ...exampleDocument(), owner: { seat: "nobody" } });
    const result = verifyChain([rev0]);
    expect(result.ok ? [] : result.errors.map((e) => e.code)).toEqual(["document"]);
  });

  it("refuses an empty log and an entry that does not parse", () => {
    expect(verifyChain([]).ok).toBe(false);
    expect(verifyChain([{ rev: 0 }]).ok).toBe(false);
  });
});
