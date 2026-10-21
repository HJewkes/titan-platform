import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { openBotIdentity, openServeBot } from "./bot-identity.js";
import { publishFingerprint } from "./bot-token-fingerprint.js";
import { scanForBotToken, type ScanPlace } from "./bot-token-scan.js";
import type { Feed } from "./test-support/a17/feed.js";
import { a17Event } from "./test-support/a17/register.js";
import { cleanFixture, plant, PLANTED, UID, writeIn, type ScanFixture } from "./test-support/bot-token.js";

const FINE_GRAINED = `github_pat_${"SYNTHETICfine".padEnd(82, "x")}`;
const PLACES: ScanPlace[] = ["env", "briefs", "logs", "transcripts", "store"];

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture(token?: string): ScanFixture {
  const root = mkdtempSync(join(tmpdir(), "factory-bot-scan-"));
  dirs.push(root);
  return cleanFixture(root, token);
}

const scan = (at: ScanFixture) => scanForBotToken(at.fingerprintFile, at.sources);

describe("the A17 bot-token leak scan (V6)", () => {
  it("finds no hit in a clean fixture whose every place holds a token-shaped decoy", () => {
    const report = scan(fixture());

    expect(report).toMatchObject({ state: "scanned", hits: [], missing: [] });
    expect(report.state === "scanned" && report.scanned).toEqual({ env: 1, briefs: 1, logs: 1, transcripts: 1, store: 1 });
  });

  it.each(PLACES)("names a token planted in %s by its place", (place) => {
    const at = fixture();
    const where = plant(at, place);

    expect(scan(at)).toMatchObject({ state: "scanned", hits: [{ place, where }] });
  });

  it("finds a fine-grained token that runs straight into more token characters", () => {
    const at = fixture(FINE_GRAINED);
    writeIn(at.sources.logs[0]!, "run.log", `x${FINE_GRAINED}_and_more\n`);

    expect(scan(at)).toMatchObject({ hits: [{ place: "logs" }] });
  });

  it("finds a token that straddles a read-chunk boundary", () => {
    const at = fixture();
    const file = writeIn(at.sources.transcripts[0]!, "big.jsonl", `${"a".repeat(1024 * 1024 - 10)} ${PLANTED}\n`);

    expect(scan(at)).toMatchObject({ hits: [{ place: "transcripts", where: file }] });
  });

  it("skips processes of another uid, which the agents' uid cannot read", () => {
    const at = fixture();
    plant(at, "env");

    expect(scanForBotToken(at.fingerprintFile, { ...at.sources, uid: UID + 1 })).toMatchObject({ hits: [], scanned: { env: 0 } });
  });

  it("reads only log files under a log dir, leaving the store's own files to the store scan", () => {
    const at = fixture();
    writeIn(at.sources.logs[0]!, "factory.sqlite3-wal", PLANTED);

    expect(scan(at)).toMatchObject({ hits: [] });
  });

  it("reports no fingerprint rather than clean when serve published none", () => {
    const at = fixture();
    publishFingerprint(at.stateDir, undefined);
    plant(at, "logs");

    expect(scan(at)).toEqual({ state: "no-fingerprint" });
  });

  it("lists a place root that is not there instead of counting it clean", () => {
    const at = fixture();
    rmSync(at.sources.briefs[0]!, { recursive: true });

    expect(scan(at)).toMatchObject({ hits: [], missing: [{ place: "briefs", root: at.sources.briefs[0] }] });
  });
});

const HEAD = "c".repeat(40);

/** The fixture's fingerprint as serve writes it: serve's own bot identity reads a 0600 token file and publishes. */
function servePublishes(at: ScanFixture): void {
  publishFingerprint(at.stateDir, undefined);
  const file = writeIn(join(at.stateDir, "..", "secrets"), "bot.token", `${PLANTED}\n`);
  chmodSync(file, 0o600);
  openServeBot(() => openBotIdentity({ path: file }), silentLogger, at.stateDir);
}

/** The feed's factory database, after the mode's ingress or pass stored a push, as the store place the scan dumps. */
async function storeFromFeed(feed: Feed, at: ScanFixture): Promise<ScanFixture> {
  await feed.fact({ type: "pr", repo: "o/r", pr: 7, head: HEAD, base: "main", action: "opened" });
  expect(feed.read("o/r#7", 0).map((row) => row.kind)).toContain("HeadPushed");
  const store = join(at.stateDir, "..", "feed.sqlite3");
  feed.db.prepare("VACUUM INTO ?").run(store);
  return { ...at, sources: { ...at.sources, store } };
}

describe("D-M1a-01 through the scan over the feed's store (TP-3403)", () => {
  a17Event("the bot's token is absent from every agent environment", async (feed) => {
    const at = await storeFromFeed(feed, fixture());
    servePublishes(at);

    const report = scan(at);

    expect(report).toMatchObject({ state: "scanned", hits: [], missing: [], scanned: { env: 1, briefs: 1, logs: 1, transcripts: 1 } });
    expect(report.state === "scanned" && report.scanned.store).toBeGreaterThan(1);
  });
});
