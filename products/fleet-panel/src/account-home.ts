import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOW_MS } from "./fixture.js";

const nowS = NOW_MS / 1000;

function writeLogin(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  const oauth = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: NOW_MS + 3_600_000, scopes: ["user:inference"] };
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }), { mode: 0o600 });
}

function writeReading(configDir: string, sessionId: string, ageSeconds: number, rateLimits: Record<string, unknown>): void {
  const dir = join(configDir, "status-cache", "sessions");
  mkdirSync(dir, { recursive: true });
  const body = { session_id: sessionId, written_at: nowS - ageSeconds, rate_limits: rateLimits };
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(body));
}

/** A temp home holding the profiles of `ACCOUNT_ROWS`; remove it with `removeAccountHome`. */
export function writeAccountHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fleet-panel-home-"));
  const acctA = join(home, ".claude-profiles", "acct-a");
  const acctB = join(home, ".claude-profiles", "acct-b");
  for (const dir of [acctA, acctB, join(home, ".claude")]) writeLogin(dir);
  writeReading(acctA, "usage-poll", 40, {
    five_hour: { used_percentage: 62, resets_at: nowS + 80 * 60 },
    seven_day: { used_percentage: 21, resets_at: nowS + 3 * 86_400 },
  });
  writeReading(acctB, "s-reviewer-b", 1_100, { five_hour: { used_percentage: 91 }, seven_day: { used_percentage: 40 } });
  return home;
}

export function removeAccountHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}
