import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineSourceFromTexts } from "@titan-design/evidence";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnerItemDeposit } from "./deposit.js";
import { DepositAnchorError, readSpool, writeDeposit } from "./spool.js";

const HEAD = "c".repeat(40);
const pins = { repo: "example/repo", head: HEAD };
const fifteen = Array.from({ length: 15 }, (_, i) => `export const v${i + 1} = ${i + 1};`).join("\n") + "\n";
const source = (rev: string) => lineSourceFromTexts(rev === HEAD ? { "src/a.ts": fifteen } : {});

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "owner-queue-anchors-"));
  dir = join(root, "deposits");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function anchored(anchors: string[], overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit {
  return {
    depositId: "d-anchor",
    asker: "agent-a",
    kind: "decide",
    door: "two-way",
    summary: "Pick a cache layout",
    context: "Two layouts fit the read path.",
    pins,
    options: [
      { id: "flat", label: "Flat", anchors },
      { id: "nested", label: "Nested" },
    ],
    ...overrides,
  };
}

const spoolFiles = async (): Promise<string[]> => readdir(dir).catch(() => []);

describe("writeDeposit with a source", () => {
  it("refuses an option anchor that starts inside the file but ends past EOF, and writes nothing", async () => {
    const write = writeDeposit(dir, anchored(["head/src/a.ts#L10-L20"]), { source });

    await expect(write).rejects.toThrow(DepositAnchorError);
    await expect(write).rejects.toThrow("head/src/a.ts#L10-L20: past EOF (15 lines)");
    expect(await spoolFiles()).toEqual([]);
  });

  it("refuses an anchor on a path that is not a file at the pinned head", async () => {
    await expect(writeDeposit(dir, anchored(["head/src/gone.ts#L1"]), { source })).rejects.toThrow(`not a file at ${HEAD}`);
    expect(await spoolFiles()).toEqual([]);
  });

  it("files a deposit whose anchors hold and quotes each one's first and last line back", async () => {
    const result = await writeDeposit(dir, anchored(["head/src/a.ts#L10-L15"], { anchors: ["head/src/a.ts#L1"] }), { source });

    expect(result.created).toBe(true);
    expect(result.anchors).toEqual([
      { anchor: "head/src/a.ts#L1", first: "export const v1 = 1;", last: "export const v1 = 1;" },
      { anchor: "head/src/a.ts#L10-L15", first: "export const v10 = 10;", last: "export const v15 = 15;" },
    ]);
    expect((await readSpool(dir)).items[0]?.pins).toEqual(pins);
  });
});

describe("anchor grammar at parse", () => {
  it("refuses anchors with no pins even without a source", async () => {
    await expect(writeDeposit(dir, anchored(["head/src/a.ts#L1"], { pins: undefined }))).rejects.toThrow(/anchors need pins/);
  });

  it("refuses a reversed range even without a source", async () => {
    await expect(writeDeposit(dir, anchored(["head/src/a.ts#L9-L3"]))).rejects.toThrow(/reversed/);
  });

  it("still accepts a free-string evidenceRef and a deposit with no anchors", async () => {
    const plain = anchored([], { evidenceRef: "see the review thread" });
    const { options = [] } = plain;
    const result = await writeDeposit(dir, { ...plain, options: options.map(({ id, label }) => ({ id, label })) }, { source });

    expect(result).toMatchObject({ created: true });
    expect(result.anchors).toBeUndefined();
  });
});
