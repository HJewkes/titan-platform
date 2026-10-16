import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The directory holding a package's `package.json`, found from its main entry. Packages hide their data files behind
 * an exports map, so this resolves the entry and walks up. `from` is a file URL or the path of a file to resolve from.
 */
export function packageDir(specifier: string, from: string): string {
  let dir = dirname(createRequire(from).resolve(specifier));
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}
