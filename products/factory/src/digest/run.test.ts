import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DigestSlot } from "./model.js";
import { deliverDigest } from "./run.js";

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => {
    chmodSync(join(root, "locked"), 0o755);
    rmSync(root, { recursive: true, force: true });
  }),
);

const SLOT: DigestSlot = { date: "2026-03-10", hour: "12" };

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-run-"));
  roots.push(dir);
  mkdirSync(join(dir, "locked"));
  return dir;
}

describe("deliverDigest", () => {
  it("copies the digest to every copy dir", async () => {
    const dir = root();

    const { written, warnings } = await deliverDigest("body", SLOT, { outDir: join(dir, "out"), copyDirs: [join(dir, "a"), join(dir, "b")] });

    expect(warnings).toEqual([]);
    expect(written).toHaveLength(3);
    for (const sub of ["out", "a", "b"]) expect(readFileSync(join(dir, sub, "2026-03-10-12.md"), "utf8")).toBe("body");
  });

  it("warns naming an unwritable dir, keeps the outDir file and still copies to the others", async () => {
    const dir = root();
    chmodSync(join(dir, "locked"), 0o555);
    const bad = join(dir, "locked", "sub");

    const { written, warnings } = await deliverDigest("body", SLOT, { outDir: join(dir, "out"), copyDirs: [bad, join(dir, "ok")] });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(bad);
    expect(existsSync(join(dir, "out", "2026-03-10-12.md"))).toBe(true);
    expect(written).toEqual([join(dir, "out", "2026-03-10-12.md"), join(dir, "ok", "2026-03-10-12.md")]);
  });

  it("warns for a copy dir that cannot be created under a plain file", async () => {
    const dir = root();
    writeFileSync(join(dir, "file"), "x");

    const { warnings } = await deliverDigest("body", SLOT, { outDir: join(dir, "out"), copyDirs: [join(dir, "file", "sub")] });

    expect(warnings).toHaveLength(1);
  });
});
