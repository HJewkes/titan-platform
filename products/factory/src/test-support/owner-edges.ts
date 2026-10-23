import { lstatSync } from "node:fs";
import { onTestFinished } from "vitest";
import { setOwnerKeysEdge } from "../owner-keys.js";
import { setOwnerPresenceEdge, type ConfirmOptions, type StatPort } from "../owner-presence.js";

const HELPER = "/synthetic/owner-presence";
const OWNER_UID = 501;
const FILE = 0o100755;
const DIR = 0o040755;

/** Swaps confirmOwner's OS edge for the rest of the current test. */
export function useOwnerPresenceEdge(edge: ConfirmOptions): void {
  onTestFinished(setOwnerPresenceEdge(edge));
}

/**
 * A helper on a clean root-owned path that prints `proof` for each dialog, or exits non-zero (a cancel) when `proof` is
 * undefined. `reasons` collects the dialog text each run was asked to show.
 */
export function fakeOwnerHelper(proof: string | undefined): { reasons: string[] } {
  const reasons: string[] = [];
  const stat: StatPort = (path) => ({ "/": { uid: 0, mode: DIR }, "/synthetic": { uid: 0, mode: DIR }, [HELPER]: { uid: 0, mode: FILE } })[path];
  useOwnerPresenceEdge({
    helperPaths: [HELPER],
    stat,
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
