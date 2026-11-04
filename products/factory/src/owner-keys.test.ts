import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOwnerKeys, OWNER_KEYS_DIR } from "./owner-keys.js";
import type { StatPort } from "./owner-presence.js";
import { keyIdOf } from "./presence-proof.js";
import { rootStat, useOwnerKeyDir } from "./test-support/owner-edges.js";

const owner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = (key = owner.publicKey): string => key.export({ type: "spki", format: "pem" }).toString();

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function keyDir(): string {
  const root = mkdtempSync(join(tmpdir(), "factory-owner-keys-"));
  dirs.push(root);
  const dir = join(root, "owner-keys");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  return dir;
}

function installKey(dir: string, name = "mac.pem", text = pem()): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, 0o644);
  return path;
}

/** Loads through the OS edge: the key directory on disk, read with `stat`. */
function loadFrom(dir: string, stat?: StatPort) {
  useOwnerKeyDir(dir, stat);
  return loadOwnerKeys();
}

describe("loadOwnerKeys", () => {
  it("loads every .pem key from a root-owned directory, by key id", () => {
    const dir = keyDir();
    installKey(dir);
    writeFileSync(join(dir, "README"), "not a key");

    const keys = loadFrom(dir);

    expect(keys).toMatchObject({ ok: true, ids: [keyIdOf(owner.publicKey)] });
  });

  it("refuses a key directory owned by the user rather than root", () => {
    const dir = keyDir();
    installKey(dir);

    const keys = loadFrom(dir, rootStat(dir, (path, real) => (path === dir ? { uid: 501, mode: real.mode } : undefined)));

    expect(keys).toEqual({ ok: false, refusal: `${dir} is owned by uid 501, not root` });
  });

  it("refuses a group-writable key directory", () => {
    const dir = keyDir();
    installKey(dir);
    chmodSync(dir, 0o775);

    expect(loadFrom(dir)).toEqual({ ok: false, refusal: `${dir} is group or other writable` });
  });

  it("refuses a group-writable parent of the key directory", () => {
    const dir = keyDir();
    installKey(dir);
    const parent = dirname(dir);
    const stat = rootStat(dir, (path, real) => (path === parent ? { uid: 0, mode: real.mode | 0o020 } : undefined));

    expect(loadFrom(dir, stat)).toEqual({ ok: false, refusal: `${parent} is group or other writable` });
  });

  it("refuses a world-writable key file", () => {
    const dir = keyDir();
    const path = installKey(dir);
    chmodSync(path, 0o646);

    expect(loadFrom(dir)).toEqual({ ok: false, refusal: `${path} is group or other writable` });
  });

  it("refuses a key file that is a symlink", () => {
    const dir = keyDir();
    const real = installKey(dir, "real.key");
    symlinkSync(real, join(dir, "mac.pem"));

    expect(loadFrom(dir)).toEqual({ ok: false, refusal: `${join(dir, "mac.pem")} is a symlink` });
  });

  it("refuses a directory with no .pem key", () => {
    const dir = keyDir();

    expect(loadFrom(dir)).toEqual({ ok: false, refusal: `no .pem key in ${dir}` });
  });

  it("refuses a missing key directory", () => {
    const dir = join(keyDir(), "absent");

    expect(loadFrom(dir)).toEqual({ ok: false, refusal: `${dir} is missing` });
  });

  it("refuses the whole set when one key is not ECDSA P-256, naming the file", () => {
    const dir = keyDir();
    installKey(dir);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const bad = installKey(dir, "old.pem", pem(rsa.publicKey));

    expect(loadFrom(dir)).toEqual({ ok: false, refusal: `${bad}: owner key is not ECDSA P-256` });
  });

  it("reads the fixed root path by default", () => {
    expect(OWNER_KEYS_DIR).toBe("/etc/titan-factory/owner-keys");
  });
});
