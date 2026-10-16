import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PENDING, REQUEST_TTL_S, approvalsDir, nodeApprovalStore, passwdHome } from "./approval-store.js";
import type { RequestFields } from "./approval-store.js";

const NOW = 1_800_000_000;
const MERGE: RequestFields = {
  digest: "a".repeat(64),
  session: "sess-1",
  aud: "mac",
  tool: "Bash",
  action: "merge",
  rule: "MRG-1",
  cwd: "/repo",
  toolInput: { command: "gh pr merge 1" },
};

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tg-approvals-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("nodeApprovalStore", () => {
  it("issues a request the owner can find by its exact action, private to this user", () => {
    const store = nodeApprovalStore(home);

    const request = store.issue(MERGE, NOW);

    expect(request).toMatchObject({ ...MERGE, issuedAt: NOW, expiresAt: NOW + REQUEST_TTL_S });
    expect(request.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(store.find(MERGE.digest, NOW)).toEqual([{ request, approval: null }]);
    expect(store.find("b".repeat(64), NOW)).toEqual([]);
    const dir = approvalsDir(home);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "requests", `${request.id}.json`)).mode & 0o777).toBe(0o600);
  });

  it("refuses a replayed approval: once spent, the request is gone and the ledger holds the nonce", () => {
    const store = nodeApprovalStore(home);
    const request = store.issue(MERGE, NOW);
    store.accept(request.id, "signed", NOW);
    expect(store.find(MERGE.digest, NOW)[0]?.approval).toBe("signed");

    expect(store.spend(request.id, request.nonce, NOW)).toBe(true);

    expect(store.find(MERGE.digest, NOW)).toEqual([]);
    expect(store.isSpent(request.nonce)).toBe(true);
    expect(store.spend(request.id, request.nonce, NOW)).toBe(false);
  });

  it("refuses a second approval for the same request", () => {
    const store = nodeApprovalStore(home);
    const request = store.issue(MERGE, NOW);
    store.accept(request.id, "first", NOW);

    expect(() => store.accept(request.id, "second", NOW)).toThrow(/EEXIST/);
    expect(store.find(MERGE.digest, NOW)[0]?.approval).toBe("first");
  });

  it("refuses an approval for a request that was never issued or has expired", () => {
    const store = nodeApprovalStore(home);
    const request = store.issue(MERGE, NOW);

    expect(() => store.accept("0123456789ab", "signed", NOW)).toThrow(/no pending request/);
    expect(() => store.accept(request.id, "signed", NOW + REQUEST_TTL_S)).toThrow(/no pending request/);
  });

  it("never follows a symlink planted at the approval path", () => {
    const store = nodeApprovalStore(home);
    const request = store.issue(MERGE, NOW);
    const target = path.join(home, "elsewhere");
    fs.writeFileSync(target, "forged");
    fs.symlinkSync(target, path.join(approvalsDir(home), "granted", `${request.id}.json`));

    expect(() => store.find(MERGE.digest, NOW)).toThrow(/ELOOP|symbolic link/);
    expect(() => store.accept(request.id, "signed", NOW)).toThrow(/EEXIST/);
    expect(fs.readFileSync(target, "utf-8")).toBe("forged");
  });

  it("skips a request file that is a planted symlink", () => {
    const store = nodeApprovalStore(home);
    const real = store.issue(MERGE, NOW);
    const planted = path.join(approvalsDir(home), "requests", "0123456789ab.json");
    fs.symlinkSync(path.join(approvalsDir(home), "requests", `${real.id}.json`), planted);

    expect(store.list(NOW).map((request) => request.id)).toEqual([real.id]);
  });

  it("refuses a store directory open to group or other", () => {
    const store = nodeApprovalStore(home);
    store.issue(MERGE, NOW);
    fs.chmodSync(approvalsDir(home), 0o755);

    expect(() => store.list(NOW)).toThrow(/open to group or other/);
  });

  it("prunes an expired request and its approval", () => {
    const store = nodeApprovalStore(home);
    const request = store.issue(MERGE, NOW);
    store.accept(request.id, "signed", NOW);

    store.prune(NOW + REQUEST_TTL_S);

    expect(store.find(MERGE.digest, NOW)).toEqual([]);
    expect(store.get(request.id, NOW)).toBeNull();
    expect(fs.readdirSync(path.join(approvalsDir(home), "granted"))).toEqual([]);
  });

  it("evicts the oldest request when one more than the cap is issued", () => {
    const store = nodeApprovalStore(home);
    const first = store.issue(MERGE, NOW);
    for (let i = 1; i < MAX_PENDING; i++) store.issue(MERGE, NOW + i);

    const last = store.issue(MERGE, NOW + MAX_PENDING);

    const ids = store.list(NOW + MAX_PENDING).map((request) => request.id);
    expect(ids).toHaveLength(MAX_PENDING);
    expect(ids).not.toContain(first.id);
    expect(ids.at(-1)).toBe(last.id);
  });

  it("ignores a request file that fails its schema", () => {
    const store = nodeApprovalStore(home);
    store.prune(NOW);
    const file = path.join(approvalsDir(home), "requests", "0123456789ab.json");
    fs.writeFileSync(file, JSON.stringify({ id: "0123456789ab", digest: MERGE.digest }), { mode: 0o600 });

    expect(store.find(MERGE.digest, NOW)).toEqual([]);
    expect(store.get("0123456789ab", NOW)).toBeNull();
  });

  it("refuses an id or nonce that could name a path outside the store", () => {
    const store = nodeApprovalStore(home);

    expect(() => store.get("../../x", NOW)).toThrow(/bad id/);
    expect(() => store.isSpent("../spent")).toThrow(/bad nonce/);
  });

  it("throws rather than reporting spent when the ledger cannot be written", () => {
    const store = nodeApprovalStore(home);
    const request = store.issue(MERGE, NOW);
    store.accept(request.id, "signed", NOW);
    const spent = path.join(approvalsDir(home), "spent");
    fs.chmodSync(spent, 0o500);
    try {
      expect(() => store.spend(request.id, request.nonce, NOW)).toThrow(/EACCES/);
      expect(store.find(MERGE.digest, NOW)[0]?.approval).toBe("signed");
    } finally {
      fs.chmodSync(spent, 0o700);
    }
  });

  it("refuses a store directory owned by another user", () => {
    const store = nodeApprovalStore(home);
    store.prune(NOW);
    const owner = fs.statSync(approvalsDir(home)).uid;
    vi.spyOn(process, "getuid").mockReturnValue(owner + 1);

    expect(() => store.list(NOW)).toThrow(/not owned by this user/);
  });

  it("writes under the given passwd home whatever HOME and XDG_STATE_HOME say", () => {
    const saved = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "tg-decoy-"));
    process.env.HOME = decoy;
    process.env.XDG_STATE_HOME = decoy;
    try {
      nodeApprovalStore(home).issue(MERGE, NOW);

      expect(fs.readdirSync(path.join(home, ".local", "state", "titan-tool-guard", "approvals", "requests"))).toHaveLength(1);
      expect(fs.readdirSync(decoy)).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });
});

// A child process, as an agent would start one: vitest's worker threads keep their own env copy, which os.homedir()
// never sees, so setting HOME in-process would not test anything.
describe("passwdHome", () => {
  it("reads the passwd entry, not the HOME a child was started with", () => {
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "tg-decoy-"));
    try {
      const source = fileURLToPath(new URL("./approval-store.ts", import.meta.url));
      const script = "const m = await import(process.argv[1]); process.stdout.write(m.passwdHome());";
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, source], { env: { ...process.env, HOME: decoy }, encoding: "utf-8" });

      expect(run.status).toBe(0);
      expect(run.stdout).toBe(passwdHome());
      expect(run.stdout).not.toBe(decoy);
    } finally {
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });
});
