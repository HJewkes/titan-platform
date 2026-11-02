import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW, fakeCredentials } from "../fixtures/fake-tokens.js";
import { makeTempHome, removeTempHome, writeFileWithMode } from "../fixtures/temp-home.js";
import { readAccounts } from "./accounts.js";
import { accountIdentity } from "./identity.js";
import { CREDENTIALS_FILE } from "./login.js";
import { sessionsDir } from "./usage-file.js";

const SECONDS = Math.floor(NOW / 1000);
const WEEK_RESET = SECONDS + 3 * 86_400;
const uid = process.getuid?.() ?? 0;

let home: string;

beforeEach(() => {
  home = makeTempHome();
});

afterEach(() => removeTempHome(home));

const dir = (label: string): string => (label === "default" ? path.join(home, ".claude") : path.join(home, ".claude-profiles", label));

function loginAs(label: string, user: string | null): void {
  writeFileWithMode(path.join(dir(label), CREDENTIALS_FILE), JSON.stringify(fakeCredentials()), 0o600);
  if (user === null) return;
  const file = label === "default" ? path.join(home, ".claude.json") : path.join(dir(label), ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: user, organizationUuid: "org-1" } }));
}

function reading(label: string, session: string, ageSeconds: number, weekly: number): void {
  fs.mkdirSync(sessionsDir(dir(label)), { recursive: true });
  const rate_limits = { seven_day: { used_percentage: weekly, resets_at: WEEK_RESET } };
  const body = { session_id: session, written_at: SECONDS - ageSeconds, rate_limits };
  fs.writeFileSync(path.join(sessionsDir(dir(label)), `${session}.json`), JSON.stringify(body));
}

// default and personal share one login; agents has its own; workout's login cannot be read.
function arrangeFleet(): void {
  loginAs("default", "user-a");
  loginAs("personal", "user-a");
  loginAs("agents", "user-b");
  loginAs("workout", null);
  reading("default", "usage-poll", 60, 40);
  reading("personal", "session-p", 30, 38);
  reading("agents", "session-a", 30, 12);
  reading("workout", "usage-poll", 90, 7);
}

describe("readAccounts", () => {
  it("gives two config dirs on one login a single row naming both dirs", () => {
    arrangeFleet();

    const rows = readAccounts({ home, env: {}, now: NOW, uid });

    const shared = rows.filter((row) => row.identity === "user-a/org-1");
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ account: "personal", config_dirs: [dir("default"), dir("personal")] });
    expect(shared[0]?.windows.seven_day?.used_pct).toBe(40);
  });

  it("keeps each dir whose identity cannot be read as its own row", () => {
    arrangeFleet();
    loginAs("server", null);

    const rows = readAccounts({ home, env: {}, now: NOW, uid, identify: (configDir) => accountIdentity(configDir, home) });

    expect(rows.map((row) => row.config_dirs)).toEqual([[dir("default"), dir("personal")], [dir("agents")], [dir("server")], [dir("workout")]]);
    expect(rows.filter((row) => row.identity === undefined).map((row) => row.account)).toEqual(["server", "workout"]);
  });
});
