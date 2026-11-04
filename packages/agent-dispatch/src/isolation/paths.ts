import fs from "node:fs";
import path from "node:path";

const realOf = (dir: string): string | undefined => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return undefined;
  }
};

/** realpath of the deepest ancestor that exists, with the missing tail rejoined, so a gone path still compares canonically. */
export function canonicalPath(dir: string): string {
  const resolved = path.resolve(dir);
  const real = realOf(resolved);
  if (real !== undefined) return real;
  const parent = path.dirname(resolved);
  return parent === resolved
    ? resolved
    : path.join(canonicalPath(parent), path.basename(resolved));
}

/** Both sides canonical; the separator check keeps a sibling `tree-2` from counting as inside `tree`. */
export const isAtOrUnder = (real: string, root: string): boolean =>
  real === root || real.startsWith(root + path.sep);
