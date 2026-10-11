import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { depositItemId, type OwnerItemDeposit } from "./deposit.js";
import type { OwnerAnswer } from "./schema.js";
import {
  MAX_DEPOSIT_BYTES,
  SpoolNameCollisionError,
  answerFileNames,
  depositFileName,
  depositFileNames,
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
    for (const name of names) expect(name).toMatch(/^[a-z0-9_%A-F]+-[a-z0-9_%A-F]+\.json$/);
    expect((await readSpool(dir)).items).toHaveLength(hostile.length);
  });

  it("gives askers and depositIds that join to the same text different files", async () => {
    await writeDeposit(dir, deposit({ asker: "a-b", depositId: "c" }));

    const second = await writeDeposit(dir, deposit({ asker: "a", depositId: "b-c" }));

    expect(second.created).toBe(true);
    expect(await readdir(dir)).toHaveLength(2);
  });

  it.each([
    ["asker", { asker: "agent-\uD800" }],
    ["depositId", { depositId: "d-\uDC00" }],
  ])("refuses a lone surrogate in the %s, which would otherwise take U+FFFD's name", async (_field, overrides) => {
    await writeDeposit(dir, deposit({ asker: "agent-�", depositId: "d-�" }));

    await expect(writeDeposit(dir, deposit({ asker: "agent-�", depositId: "d-�", ...overrides }))).rejects.toThrow(/well-formed/);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("files a surrogate pair, which is well-formed", async () => {
    const { created } = await writeDeposit(dir, deposit({ asker: "agent-😀" }));

    expect(created).toBe(true);
  });

  it("gives Bob and bob names that differ even on a case-insensitive filesystem", async () => {
    const upper = await writeDeposit(dir, deposit({ asker: "Bob" }));
    const lower = await writeDeposit(dir, deposit({ asker: "bob" }));

    expect([upper.created, lower.created]).toEqual([true, true]);
    expect(depositFileName("Bob", "d-1").toLowerCase()).not.toBe(depositFileName("bob", "d-1").toLowerCase());
  });

  it("refuses rather than answer created:false when its name holds a different deposit", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, depositFileName("bob", "d-1")), JSON.stringify(deposit({ asker: "Bob" })));

    await expect(writeDeposit(dir, deposit({ asker: "bob" }))).rejects.toThrow(SpoolNameCollisionError);
  });
});

describe("a deposit filed before A-Z was escaped", () => {
  const LEGACY_NAME = "Bob-d%2D1.json";

  beforeEach(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, LEGACY_NAME), JSON.stringify(deposit({ asker: "Bob" })));
  });

  it("is still read under its legacy name", async () => {
    const { items, rejects } = await readSpool(dir);

    expect(rejects).toEqual([]);
    expect(items.map((item) => item.id)).toEqual([depositItemId("Bob", "d-1")]);
    expect(depositFileNames("Bob", "d-1")).toEqual([depositFileName("Bob", "d-1"), LEGACY_NAME]);
  });

  it("answers a repeat with created:false and writes no second copy", async () => {
    const repeat = await writeDeposit(dir, deposit({ asker: "Bob" }));

    expect(repeat).toEqual({ file: join(dir, LEGACY_NAME), created: false });
    expect(await readdir(dir)).toEqual([LEGACY_NAME]);
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

  it("reads and keeps an answer filed under its legacy name", async () => {
    const [current, legacy] = answerFileNames("deposit:X");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, legacy!), JSON.stringify(ANSWER));

    const second = await writeAnswer(dir, "deposit:X", { ...ANSWER, optionId: "nested" });

    expect(legacy).toBe("deposit%3AX.answer.json");
    expect(await readAnswer(dir, "deposit:X")).toEqual(ANSWER);
    expect(second).toEqual({ file: join(dir, legacy!), created: false });
    expect(await readdir(dir)).not.toContain(current);
  });

  it("refuses a malformed answer", async () => {
    await expect(writeAnswer(dir, "deposit:x", { at: "yesterday" } as unknown as OwnerAnswer)).rejects.toThrow();
  });
});
