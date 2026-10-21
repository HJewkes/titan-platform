import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { publishFingerprint } from "./bot-token-fingerprint.js";
import type { ScanPlace } from "./bot-token-scan.js";
import { EXIT, runCli } from "./cli.js";
import { cleanFixture, plant, PLANTED, type ScanFixture } from "./test-support/bot-token.js";

const PLACES: ScanPlace[] = ["env", "briefs", "logs", "transcripts", "store"];

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture(): ScanFixture {
  const root = mkdtempSync(join(tmpdir(), "factory-bot-scan-cli-"));
  dirs.push(root);
  return cleanFixture(root);
}

/** Every place is pointed at the fixture, so the scan never reads the real /proc or home. */
async function scanCli(at: ScanFixture, ...extra: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const { procRoot, briefs, logs, transcripts, store } = at.sources;
  const args = ["bot-token", "scan", "--fingerprint", at.fingerprintFile, "--proc", procRoot, "--briefs", ...briefs, "--logs", ...logs, "--transcripts", ...transcripts, "--store", store!, ...extra];
  const code = await runCli(args, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: { HOME: "/nonexistent" } });
  return { code, out: out.join(""), err: err.join("") };
}

describe("titan-factory bot-token scan", () => {
  it("exits 0 and says clean when no place holds the token", async () => {
    const result = await scanCli(fixture());

    expect(result.code).toBe(EXIT.OK);
    expect(result.out).toContain("bot-token scan: clean");
  });

  it.each([
    ["text", [], (out: string) => out.split("\n").flatMap((line) => /^HIT (\S+) /.exec(line)?.[1] ?? [])],
    ["json", ["--json"], (out: string) => z.object({ hits: z.array(z.object({ place: z.string() })) }).parse(JSON.parse(out)).hits.map((hit) => hit.place)],
  ])("names every place a hit is in and never prints the token (%s)", async (_format, extra: string[], placesOf: (out: string) => string[]) => {
    const at = fixture();
    PLACES.forEach((place) => plant(at, place));

    const result = await scanCli(at, ...extra);

    expect(result.code).toBe(EXIT.FAILURE);
    expect(placesOf(result.out)).toEqual(PLACES);
    expect(`${result.out}${result.err}`).not.toContain(PLANTED);
    expect(`${result.out}${result.err}`).not.toContain(PLANTED.slice(4));
  });

  it("exits non-zero with no fingerprint and never claims clean", async () => {
    const at = fixture();
    publishFingerprint(at.stateDir, undefined);

    const result = await scanCli(at);

    expect(result.code).toBe(EXIT.UNAVAILABLE);
    expect(result.err).toContain("no fingerprint");
    expect(`${result.out}${result.err}`).not.toContain("clean");
  });
});
