import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PENDING, REQUEST_TTL_S, approvalsDir, nodeApprovalStore } from "./approval-store.js";
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
