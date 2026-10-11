/**
 * API surface snapshots: one normalized d.ts per public package exports entry, committed under
 * packages/<dir>/api/ so a pull request that changes a public signature shows it in the diff.
 *
 * An entry's d.ts re-exports from tsup's shared declaration chunks, which hold much of the real
 * surface, so each snapshot inlines the chunks its entry reaches. Chunk file names carry a content
 * hash; normalization drops it so a rebuild that reshuffles chunks leaves the snapshot alone.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

export class MissingDistError extends Error {
  constructor(pkgName, file) {
    super(`${pkgName}: ${file} is missing. Run pnpm build first.`);
    this.name = "MissingDistError";
  }
}

// rollup-plugin-dts names a chunk `<name>-<8 char base64url hash>`; a real hash has a capital, digit, `_` or `-`.
// An all-lowercase hash (about 1 build in 1,400 per chunk) is kept, so it shows as a one-line rename in the diff;
// matching it would also strip real lowercase names such as `-handlers`.
const HASHED = /-(?=[a-z]*[A-Z0-9_-])[A-Za-z0-9_-]{8}(?=\.(?:d\.[cm]?ts|[cm]?js)\b)/;
const RELATIVE_FROM = /(\bfrom\s*|\bimport\s*)(["'])(\.{1,2}\/[^"']+)\2/g;

function typesOf(target) {
  if (typeof target === "string") return target.endsWith(".d.ts") ? target : null;
  return target?.types ?? null;
}

/** Each exports entry that declares types, named for its snapshot file: "." is index, "./limits/node" is limits/node. */
export function entriesOf(pkgJson) {
  const exportsMap = typeof pkgJson.exports === "string" ? { ".": pkgJson.exports } : (pkgJson.exports ?? {});
  return Object.entries(exportsMap)
    .map(([key, target]) => ({ name: key === "." ? "index" : key.replace(/^\.\//, ""), types: typesOf(target) }))
    .filter((e) => e.types !== null);
}

function stripHash(spec) {
  return spec.replace(HASHED, "");
}

/** Text that changes only when the declared surface does. */
export function normalizeDts(text) {
  return `${text
    .replace(RELATIVE_FROM, (_, kw, q, spec) => `${kw}${q}${stripHash(spec)}${q}`)
    .split("\n")
    .filter((line) => !line.startsWith("//# sourceMappingURL="))
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()}\n`;
}

function relativeDts(file, text) {
  const specs = [...text.matchAll(RELATIVE_FROM)].map(([, , , spec]) => spec);
  return specs.map((spec) => normalize(join(dirname(file), spec.replace(/\.([cm]?)js$/, ".d.$1ts"))));
}

/** The entry file, then every shared chunk it reaches; other entries are left to their own snapshots. */
function snapshotFiles(entryFile, otherEntries) {
  const seen = new Set([entryFile]);
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const next of relativeDts(file, readFileSync(file, "utf8"))) {
      if (seen.has(next) || otherEntries.has(next) || !existsSync(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  const [entry, ...chunks] = seen;
  return [entry, ...chunks.sort()];
}

function snapshotText(pkgDir, entryFile, otherEntries) {
  const [entry, ...chunks] = snapshotFiles(entryFile, otherEntries);
  const parts = [normalizeDts(readFileSync(entry, "utf8"))];
  for (const chunk of chunks) {
    parts.push(`// ${stripHash(`./${relative(pkgDir, chunk)}`)}\n${normalizeDts(readFileSync(chunk, "utf8"))}`);
  }
  return parts.join("\n");
}

/** Snapshots for one package; throws MissingDistError when a declared types file has not been built. */
export function packageSnapshots(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  if (pkg.private === true) return [];
  const entries = entriesOf(pkg).map((e) => ({ ...e, file: normalize(join(pkgDir, e.types)) }));
  const missing = entries.find((e) => !existsSync(e.file));
  if (missing) throw new MissingDistError(pkg.name, missing.types);
  const files = new Set(entries.map((e) => e.file));
  return entries.map((e) => {
    const others = new Set([...files].filter((f) => f !== e.file));
    return { path: join(pkgDir, "api", `${e.name}.d.ts`), text: snapshotText(pkgDir, e.file, others) };
  });
}

/** `{path, text}` for every exports entry of every non-private package under `root`/packages. */
export function snapshotOutputs(root) {
  const base = join(root, "packages");
  return readdirSync(base)
    .sort()
    .filter((dir) => existsSync(join(base, dir, "package.json")))
    .flatMap((dir) => packageSnapshots(join(base, dir)));
}
