import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { setOwnerKeysEdge } from "../owner-keys.js";
import { setOwnerPresenceEdge, type ConfirmOptions, type StatPort } from "../owner-presence.js";
import { keyIdOf } from "../presence-proof.js";

const HELPER = "/synthetic/owner-presence";
const OWNER_UID = 501;
const FILE = 0o100755;
const DIR = 0o040755;

const helperStat: StatPort = (path) => ({ "/": { uid: 0, mode: DIR }, "/synthetic": { uid: 0, mode: DIR }, [HELPER]: { uid: 0, mode: FILE } })[path];

/** Swaps the owner-presence helper's OS edge for the rest of the current test. */
export function useOwnerPresenceEdge(edge: ConfirmOptions): void {
  onTestFinished(setOwnerPresenceEdge(edge));
}

/**
 * A helper on a clean root-owned path that prints `proof` for each dialog, or exits non-zero (a cancel) when `proof` is
 * undefined. `reasons` collects the dialog text each run was asked to show.
 */
export function fakeOwnerHelper(proof: string | undefined): { reasons: string[] } {
  const reasons: string[] = [];
  useOwnerPresenceEdge({
    helperPaths: [HELPER],
    stat: helperStat,
    getuid: () => OWNER_UID,
    report: () => {},
    run: async (_file, args) => {
      reasons.push(args[0]!);
      if (proof === undefined) throw Object.assign(new Error("cancelled"), { code: 1 });
      return `${proof}\n`;
    },
  });
  return { reasons };
}

/** The owner's synthetic enclave key: its public half installed in a temp owner-keys dir loadOwnerKeys reads. */
interface FakeSigner {
  /** The dialog text each `sign` run showed. */
  reasons: string[];
  /** Signs any bytes with the installed key, as a test-side forger with the owner's key would. */
  signBytes: (bytes: Uint8Array) => string;
}

/**
 * A helper on a clean root-owned path whose `pubkey --id` and `sign` use a fresh P-256 key, installed in the owner key
 * ring for the rest of the current test. With `cancel`, every `sign` exits non-zero as a cancelled dialog does.
 */
export function fakeOwnerSigner({ cancel = false }: { cancel?: boolean } = {}): FakeSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const dir = mkdtempSync(join(tmpdir(), "factory-owner-keys-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "owner.pem"), publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  chmodSync(join(dir, "owner.pem"), 0o644);
  useOwnerKeyDir(dir);
  const signBytes = (bytes: Uint8Array): string => sign("sha256", bytes, { key: privateKey, dsaEncoding: "der" }).toString("base64url");
  const reasons: string[] = [];
  useOwnerPresenceEdge({
    helperPaths: [HELPER],
    stat: helperStat,
    getuid: () => OWNER_UID,
    report: () => {},
    run: async (_file, args, input) => {
      if (args[0] === "pubkey") return `${keyIdOf(publicKey)}\n`;
      reasons.push(args.at(-1)!);
      if (cancel || input === undefined) throw Object.assign(new Error("cancelled"), { code: 1 });
      return `${signBytes(input)}\n`;
    },
  });
  return { reasons, signBytes };
}

/** The real lstat with every component owned by root, since a test cannot chown; parents outside `dir` (a sticky /tmp) lose their write bits. */
export function rootStat(dir: string, override: (path: string, real: { uid: number; mode: number }) => { uid: number; mode: number } | undefined = () => undefined): StatPort {
  return (path) => {
    const real = lstatSync(path, { throwIfNoEntry: false });
    if (real === undefined) return undefined;
    const inside = path === dir || path.startsWith(`${dir}/`);
    return override(path, real) ?? { uid: 0, mode: inside ? real.mode : real.mode & ~0o022 };
  };
}

/** Makes loadOwnerKeys read `dir` on disk, through `stat`, for the rest of the current test. */
export function useOwnerKeyDir(dir: string, stat: StatPort = rootStat(dir)): void {
  onTestFinished(setOwnerKeysEdge({ dir, stat }));
}
