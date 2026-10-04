import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDir = join(import.meta.dirname, "..");
const built = existsSync(join(packageDir, "dist", "index.js"));

// Packs the built package the way a release does, so the assertions see the published tarball.
function packAndExtract(into: string): string {
  execFileSync("pnpm", ["pack", "--pack-destination", into], { cwd: packageDir, stdio: "pipe" });
  const tarball = readdirSync(into).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack produced no tarball");
  execFileSync("tar", ["-xzf", tarball], { cwd: into });
  return join(into, "package");
}

describe.skipIf(!built)("the packed hitl tarball", () => {
  let scratch: string;
  let unpacked: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "hitl-pack-"));
    unpacked = packAndExtract(scratch);
  }, 60_000);

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("ships a NOTICE carrying the openrig copyright and the Apache-2.0 text", () => {
    const notice = readFileSync(join(unpacked, "NOTICE"), "utf8");

    expect(notice).toContain("https://github.com/mvschwarz/openrig");
    expect(notice).toContain("packages/daemon/src/domain/human-questions.ts");
    expect(notice).toContain("Copyright 2026 Mike Schwarz");
    expect(notice).toContain("Version 2.0, January 2004");
    expect(notice).toContain("END OF TERMS AND CONDITIONS");
  });

  it("keeps gate-brief's openrig header as a legal comment in dist", () => {
    const distDir = join(unpacked, "dist");
    const bundles = readdirSync(distDir).filter((name) => name.endsWith(".js"));
    const sources = bundles.map((name) => readFileSync(join(distDir, name), "utf8"));

    const legal = sources.filter((source) => /\/\*![^]*?openrig[^]*?Mike Schwarz[^]*?@license Apache-2\.0/.test(source));
    expect(legal.length).toBeGreaterThan(0);
  });
});
