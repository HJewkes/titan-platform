import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TP-4561: the CLI runs under plain node, where react-ui's motion entry (and its root entry) resolve to raw
 * react-native and crash at load. Vitest aliases react-native to react-native-web, so only a walk of the static
 * import graph from bin.ts, the path node loads before any command runs, sees what the release would load.
 * Dynamic imports are left out: they load only on the command that asks for them.
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const NODE_UNSAFE = /^(?:react-native(?:\/.*)?|@titan-design\/react-ui(?:\/motion)?)$/;
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function resolveLocal(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier).replace(/\.js$/, "");
  const found = [".ts", ".tsx", "/index.ts"].map((ext) => base + ext).find((path) => existsSync(path));
  if (found === undefined) throw new Error(`${relative(SRC, fromFile)}: cannot resolve ${specifier}`);
  return found;
}

function nodeUnsafeImports(entry: string): string[] {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      if (specifier === undefined) continue;
      if (specifier.startsWith(".")) queue.push(resolveLocal(file, specifier));
      else if (NODE_UNSAFE.test(specifier)) offenders.push(`${relative(SRC, file)} -> ${specifier}`);
    }
  }
  return offenders.sort();
}

describe("the explainer CLI under plain node", () => {
  it("loads nothing from bin.ts that pulls react-native into node", () => {
    const entry = resolve(SRC, "bin.ts");

    const offenders = nodeUnsafeImports(entry);

    expect(offenders).toEqual([]);
  });
});
