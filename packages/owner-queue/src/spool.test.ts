import { mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { depositItemId, type OwnerItemDeposit } from "./deposit.js";
import type { OwnerAnswer } from "./schema.js";
import {
  MAX_DEPOSIT_BYTES,
  depositFileName,
  readAnswer,
  readSpool,
  writeAnswer,
  writeDeposit,
} from "./spool.js";

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "owner-queue-spool-"));
  dir = join(root, "deposits");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deposit(overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit {
  return {
    depositId: "d-1",
    asker: "agent-a",
    kind: "decide",
    door: "two-way",
    summary: "Pick a cache layout",
    context: "Two layouts fit the read path.",
    options: [
      { id: "flat", label: "Flat" },
      { id: "nested", label: "Nested" },
    ],
    ...overrides,
  };
}

const ANSWER: OwnerAnswer = {
  optionId: "flat",
  by: { class: "owner", id: "o", channel: "web" },
  at: "2026-01-01T00:00:00Z",
};

describe("writeDeposit", () => {
  it("files an owner-only file that readSpool returns as an open item opened at its mtime", async () => {
    const { file, created } = await writeDeposit(dir, deposit());

    const { items, rejects } = await readSpool(dir);
    expect(created).toBe(true);
    expect(file).toBe(join(dir, "agent%2Da-d%2D1.json"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(rejects).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: depositItemId("agent-a", "d-1"), status: "open", summary: "Pick a cache layout" });
    expect(items[0]?.openedAt).toBe((await stat(file)).mtime.toISOString());
  });

  it("keeps the first deposit when the same asker repeats a depositId", async () => {
    await writeDeposit(dir, deposit());

    const again = await writeDeposit(dir, deposit({ summary: "Pick a cache layout, revised" }));

    expect(again.created).toBe(false);
    expect((await readSpool(dir)).items.map((item) => item.summary)).toEqual(["Pick a cache layout"]);
  });

  it("leaves one file and no temp files when many writers race on one depositId", async () => {
    const writers = Array.from({ length: 25 }, (_, n) => writeDeposit(dir, deposit({ summary: `Attempt ${n}` })));

    const results = await Promise.all(writers);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await readdir(dir)).toEqual([depositFileName("agent-a", "d-1")]);
  });

  it("refuses a deposit whose context is 64 KB and writes nothing", async () => {
    const huge = deposit({ context: "x".repeat(MAX_DEPOSIT_BYTES) });

    await expect(writeDeposit(dir, huge)).rejects.toThrow(RangeError);
    expect(await readSpool(dir)).toEqual({ items: [], rejects: [] });
  });

  it("refuses a deposit that sets a system field", async () => {
    const forged = { ...deposit(), status: "answered" } as OwnerItemDeposit;

    await expect(writeDeposit(dir, forged)).rejects.toThrow();
  });

  it("keeps hostile askers and depositIds inside the spool as flat file names", async () => {
    const hostile = [
      deposit({ asker: "../../escape", depositId: "../x" }),
      deposit({ asker: "/abs/path", depositId: "a\\b" }),
      deposit({ asker: "nul\0byte", depositId: ".." }),
    ];

    for (const each of hostile) await writeDeposit(dir, each);

    const names = await readdir(dir);
    expect(await readdir(root)).toEqual(["deposits"]);
    expect(names).toHaveLength(hostile.length);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_%]+-[A-Za-z0-9_%]+\.json$/);
    expect((await readSpool(dir)).items).toHaveLength(hostile.length);
  });

  it("gives askers and depositIds that join to the same text different files", async () => {
    await writeDeposit(dir, deposit({ asker: "a-b", depositId: "c" }));

    const second = await writeDeposit(dir, deposit({ asker: "a", depositId: "b-c" }));

    expect(second.created).toBe(true);
    expect(await readdir(dir)).toHaveLength(2);
  });
});

describe("readSpool", () => {
  it("reads a missing spool as empty", async () => {
    expect(await readSpool(join(root, "absent"))).toEqual({ items: [], rejects: [] });
  });

  it("puts bad files in rejects and still returns the good deposits", async () => {
    await writeDeposit(dir, deposit());
    await writeFile(join(dir, "broken.json"), "{ not json");
    await writeFile(join(dir, "forged.json"), JSON.stringify({ ...deposit(), status: "answered" }));
    await symlink(join(root, "elsewhere.json"), join(dir, "linked.json"));

    const { items, rejects } = await readSpool(dir);

    expect(items).toHaveLength(1);
    expect(rejects.map((reject) => reject.file)).toEqual(["broken.json", "forged.json", "linked.json"]);
    expect(rejects[0]?.reason).toBe("not valid JSON");
    expect(rejects[2]?.reason).toBe("not a regular file");
  });

  it("rejects a deposit filed under a name that is not its own", async () => {
    const { file } = await writeDeposit(dir, deposit());
    await rename(file, join(dir, "agent%2Db-d%2D1.json"));

    const { items, rejects } = await readSpool(dir);

    expect(items).toEqual([]);
    expect(rejects).toEqual([{ file: "agent%2Db-d%2D1.json", reason: "file name does not match its asker and depositId" }]);
  });

  it("rejects an oversized file without reading it", async () => {
    await writeDeposit(dir, deposit());
    await writeFile(join(dir, "big.json"), " ".repeat(MAX_DEPOSIT_BYTES + 1));

    expect((await readSpool(dir)).rejects).toEqual([{ file: "big.json", reason: `larger than ${MAX_DEPOSIT_BYTES} bytes` }]);
  });
});

describe("writeAnswer and readAnswer", () => {
  it("keeps the answer beside the deposit without readSpool mistaking it for one", async () => {
    await writeDeposit(dir, deposit());
    const id = depositItemId("agent-a", "d-1");

    const { file } = await writeAnswer(dir, id, ANSWER);

    expect(file).toBe(join(dir, `deposit%3A${id.slice("deposit:".length)}.answer.json`));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readAnswer(dir, id)).toEqual(ANSWER);
    expect(await readSpool(dir)).toMatchObject({ rejects: [], items: [{ id }] });
  });

  it("returns undefined when no answer is filed", async () => {
    expect(await readAnswer(dir, "deposit:none")).toBeUndefined();
  });

  it("keeps the first answer", async () => {
    await writeAnswer(dir, "deposit:x", ANSWER);

    const second = await writeAnswer(dir, "deposit:x", { ...ANSWER, optionId: "nested" });

    expect(second.created).toBe(false);
    expect(JSON.parse(await readFile(second.file, "utf8"))).toMatchObject({ optionId: "flat" });
  });

  it("refuses a malformed answer", async () => {
    await expect(writeAnswer(dir, "deposit:x", { at: "yesterday" } as unknown as OwnerAnswer)).rejects.toThrow();
  });
});
