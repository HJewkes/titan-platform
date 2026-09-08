import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite } from "./atomic-write.js";
import { contentHash } from "./hash.js";
import { mirrorFile, resolveSource } from "./mirror.js";
import { readLocatorText } from "./read-locator.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "locator-durability-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readLocatorText", () => {
  it("returns exactly the addressed bytes", async () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, 'first\n{"k":"é"}\nlast\n');
    expect(await readLocatorText(file, [0, 6, 10])).toBe('{"k":"é"}');
  });

  it("throws when the file has shrunk past the span", async () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, "short\n");
    await expect(readLocatorText(file, [0, 2, 50])).rejects.toThrow(/runs past the end/);
  });
});

describe("mirrorFile and resolveSource", () => {
  it("stores a content-addressed copy once and resolves to it after the source is gone", async () => {
    const source = path.join(dir, "t.jsonl");
    const mirrorDir = path.join(dir, "mirror");
    writeFileSync(source, "payload\n");

    const first = await mirrorFile(source, mirrorDir);
    const second = await mirrorFile(source, mirrorDir);
    expect(first.hash).toBe(await contentHash(source));
    expect(first.copied).toBe(true);
    expect(second).toEqual({ ...first, copied: false });
    expect(readFileSync(first.mirrorPath, "utf8")).toBe("payload\n");

    expect(await resolveSource(source, mirrorDir, first.hash)).toBe(source);
    unlinkSync(source);
    expect(await resolveSource(source, mirrorDir, first.hash)).toBe(first.mirrorPath);
    expect(await resolveSource(source, mirrorDir, null)).toBeNull();
  });
});

describe("atomicWrite", () => {
  it("replaces the target without leaving a temp file behind", async () => {
    const target = path.join(dir, "state.json");
    await atomicWrite(target, "one");
    await atomicWrite(target, "two");
    expect(readFileSync(target, "utf8")).toBe("two");
    expect(existsSync(target)).toBe(true);
    const leftovers = readFileSync(target, "utf8") === "two" && !existsSync(`${target}.tmp`);
    expect(leftovers).toBe(true);
  });
});
