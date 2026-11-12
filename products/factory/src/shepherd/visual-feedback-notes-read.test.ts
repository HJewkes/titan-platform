import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRegularText } from "./visual-feedback-notes-read.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "notes-read-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("the notes sweep file reader", () => {
  it("reads a regular file", async () => {
    await writeFile(join(dir, "a.json"), "{}");

    expect(await readRegularText(join(dir, "a.json"))).toBe("{}");
  });

  it("skips a symlinked file, even to a readable one", async () => {
    await writeFile(join(dir, "real.json"), "{}");
    await symlink(join(dir, "real.json"), join(dir, "feedback.json"));

    expect(await readRegularText(join(dir, "feedback.json"))).toBeUndefined();
  });

  it("skips an absent file and an oversized one", async () => {
    await writeFile(join(dir, "big.json"), "x".repeat(1024 * 1024 + 1));

    expect(await readRegularText(join(dir, "none.json"))).toBeUndefined();
    expect(await readRegularText(join(dir, "big.json"))).toBeUndefined();
  });
});
