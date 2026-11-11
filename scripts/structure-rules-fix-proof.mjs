// Structure rules that read the fix-proof config. Split from structure-rules.mjs to stay under the file cap.
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".worktrees"]);
const READER_FILE = /\.(?:json|[cm]?[jt]sx?|ya?ml|sh)$/;
const CARRIED_TSCONFIG_NAME = /^tsconfig\..+\.json$/;
const TOKEN = /[^\s"'`=:,()]*tsconfig[^\s"'`=:,()]*/g;
const RUNS_TYPECHECK = /\b(?:pnpm|npm|yarn|bun|turbo)\b[^&|;]*\btypecheck\b/;
const toPosix = (path) => path.split(sep).join("/");

function realTarget(root, path) {
  try {
    return toPosix(relative(realpathSync(root), realpathSync(join(root, path))));
  } catch {
    return null;
  }
}

function walk(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : walk(root, path);
    const kind = entry.isSymbolicLink() ? "link" : entry.isFile() ? "file" : null;
    return kind ? [{ kind, path: toPosix(relative(root, path)) }] : [];
  });
}

// Resolve every tsconfig-looking token against the referring file's folder, so a reference counts only when it lands on a carried file.
function referencedTargets(path, text, carried, compileGlobs) {
  const hits = new Set();
  for (const [token] of text.matchAll(TOKEN)) {
    const resolved = posix.normalize(posix.join(posix.dirname(path), token));
    const matches = /[*?[{]/.test(token) ? compileGlobs([resolved]) : (candidate) => candidate === resolved;
    carried.filter(matches).forEach((target) => hits.add(target));
  }
  return [...hits];
}

function manifestProblems(path, manifest, carried, compileGlobs) {
  const { scripts = {}, ...rest } = manifest;
  const dir = posix.dirname(path);
  const own = carried.filter((target) => posix.dirname(target) === dir);
  const named = Object.entries(scripts).flatMap(([key, value]) =>
    referencedTargets(path, String(value), carried, compileGlobs)
      .filter((target) => !(key === "typecheck" && posix.dirname(target) === dir))
      .map((target) => ({ target, how: `script \`${key}\`` })),
  );
  const chained = own.length === 0 ? [] : Object.entries(scripts)
    .filter(([key, value]) => key !== "typecheck" && RUNS_TYPECHECK.test(String(value)))
    .map(([key]) => ({ target: own[0], how: `script \`${key}\`, which runs \`typecheck\`,` }));
  const elsewhere = referencedTargets(path, JSON.stringify(rest), carried, compileGlobs).map((target) => ({ target, how: "a field" }));
  return [...named, ...chained, ...elsewhere];
}

function problemsIn(root, path, carried, compileGlobs) {
  const text = readFileSync(join(root, path), "utf8");
  if (posix.basename(path) === "package.json") return manifestProblems(path, JSON.parse(text), carried, compileGlobs);
  return referencedTargets(path, text, carried, compileGlobs).filter((target) => target !== path).map((target) => ({ target, how: "it" }));
}

/**
 * R61 (TP-5200): only a package's `typecheck` script may name a tsconfig the fix-proof config carries.
 * A carried file counts as test support, so a build that read it would let a test-only change alter shipped output.
 * References are resolved to paths, so two packages may each carry their own file. A symlink to a carried file, a wildcard
 * that matches one, and a script that runs `typecheck` all count as naming it.
 */
export async function checkCarriedTsconfigReferences(root) {
  const { compileGlobs, parseFixProofConfig, CONFIG_PATH } = await import("../packages/fix-proof/dist/index.js");
  const parsed = parseFixProofConfig(existsSync(join(root, CONFIG_PATH)) ? readFileSync(join(root, CONFIG_PATH), "utf8") : null);
  if (!parsed.ok) return [parsed.error];
  const isCarried = compileGlobs(parsed.config.carry);
  const isTest = compileGlobs(parsed.config.tests);
  const entries = walk(root).filter(({ path }) => path !== CONFIG_PATH);
  const files = entries.filter(({ kind }) => kind === "file").map(({ path }) => path);
  // A plain `tsconfig.json` under a fixtures glob is carried too, but every package names its own by that basename, so only `tsconfig.<x>.json` is tracked.
  const carried = files.filter((path) => CARRIED_TSCONFIG_NAME.test(posix.basename(path)) && isCarried(path));
  const message = (path, target, how) => `\`${path}\` names \`${target}\` (${how}), which \`${CONFIG_PATH}\` carries as test support. Only a package \`typecheck\` script may; a build that read it would let a test-only change alter shipped output (R61, TP-5200).`;
  const links = entries.filter(({ kind }) => kind === "link").flatMap(({ path }) => {
    const target = realTarget(root, path);
    return carried.includes(target) ? [message(path, target, "a symlink")] : [];
  });
  const readers = files.filter((path) => READER_FILE.test(path) && !isTest(path));
  const named = readers.flatMap((path) =>
    problemsIn(root, path, carried, compileGlobs).map(({ target, how }) => message(path, target, how)),
  );
  return [...links, ...named];
}
