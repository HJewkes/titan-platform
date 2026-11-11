import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrictionDay } from "../shepherd/owner-friction.js";
import { fakeSources, NOW, SLOT as FAKE_SLOT } from "../test-support/digest.js";
import type { DigestSlot } from "./model.js";
import { buildDigest, deliverDigest } from "./run.js";

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => {
    chmodSync(join(root, "locked"), 0o755);
    rmSync(root, { recursive: true, force: true });
  }),
);

const SLOT: DigestSlot = { date: "2026-03-10", hour: "12" };
const ORIGIN = "https://console.example.ts.net";

const friction = (medianHours: number): FrictionDay => ({ day: "2026-03-10", ownerTouches: 1, kinds: [{ kind: "approve-merge", gates: 4, medianHours, maxHours: medianHours }] });

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

describe("buildDigest", () => {
  it("a console that answers 502 leaves the alarm without links and says why under gaps", async () => {
    const built = await buildDigest({ sources: fakeSources({ friction: () => friction(98) }), now: NOW, slot: FAKE_SLOT, windowMinutes: 360, full: false, consoleOrigin: ORIGIN, probe: async () => 502 });

    expect(built.markdown).toContain("- digest.consoleOrigin https://console.example.ts.net answered 502,");
    expect(built.markdown).not.toContain("consoleOrigin unset");
    expect(built.alarmNote).toBeDefined();
  });

  it("a digest whose alarm does not fire never probes", async () => {
    const probe = vi.fn(async () => 200);

    await buildDigest({ sources: fakeSources(), now: NOW, slot: FAKE_SLOT, windowMinutes: 360, full: false, consoleOrigin: ORIGIN, probe });

    expect(probe).not.toHaveBeenCalled();
  });
});
