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

// A tool runs from a folder the file text does not name: a package file's tools run from its own folder or the repo root,
// while a workflow, root script or root manifest may run from the root or from any package (`working-directory`).
function readFrom(path, ctx) {
  const dir = posix.dirname(path);
  const loose = !ctx.packageDirs.some((packageDir) => path.startsWith(`${packageDir}/`));
  return [...new Set([dir, ".", ...(loose ? ctx.carried.map((target) => posix.dirname(target)) : [])])];
}

function referencedTargets(path, text, ctx) {
  const bases = readFrom(path, ctx);
  const hits = new Set();
  for (const [raw] of text.matchAll(TOKEN)) {
    // A variable or template prefix (`${here}/`, `$ROOT/`) is a folder the scan cannot know, so it is read as "some base".
    const token = raw.replace(/\$\{[^}]*\}|\$\w+/g, "").replace(/^\/+/, "");
    for (const base of bases) {
      const resolved = posix.normalize(posix.join(base, token));
      const matches = /[*?[{]/.test(token) ? ctx.compileGlobs([resolved]) : (candidate) => candidate === resolved;
      ctx.carried.filter(matches).forEach((target) => hits.add(target));
    }
  }
  return [...hits];
}

function chainedTypecheck(path, scripts, ctx) {
  const dir = posix.dirname(path);
  const reached = ctx.carried.filter((target) => posix.dirname(target) === dir);
  const rootLevel = !ctx.packageDirs.some((packageDir) => path.startsWith(`${packageDir}/`));
  const target = reached[0] ?? (rootLevel ? ctx.carried[0] : undefined);
  if (target === undefined) return [];
  return Object.entries(scripts)
    .filter(([key, value]) => key !== "typecheck" && RUNS_TYPECHECK.test(String(value)))
    .map(([key]) => ({ target, how: `script \`${key}\`, which runs \`typecheck\`,` }));
}

function manifestProblems(path, manifest, ctx) {
  const { scripts = {}, ...rest } = manifest;
  const dir = posix.dirname(path);
  const named = Object.entries(scripts).flatMap(([key, value]) =>
    referencedTargets(path, String(value), ctx)
      .filter((target) => !(key === "typecheck" && posix.dirname(target) === dir))
      .map((target) => ({ target, how: `script \`${key}\`` })),
  );
  const elsewhere = referencedTargets(path, JSON.stringify(rest), ctx).map((target) => ({ target, how: "a field" }));
  return [...named, ...chainedTypecheck(path, scripts, ctx), ...elsewhere];
}

// A turbo task that depends on `typecheck` runs it as part of that task, so it counts like a script that runs it.
function turboProblems(path, turbo, ctx) {
  if (ctx.carried.length === 0) return [];
  const tasks = Object.entries(turbo.tasks ?? turbo.pipeline ?? {});
  return tasks
    .filter(([name, task]) => name.split("#").pop() !== "typecheck" && (task.dependsOn ?? []).some((dep) => /(?:^|[\^#])typecheck$/.test(dep)))
    .map(([name]) => ({ target: ctx.carried[0], how: `task \`${name}\`, which depends on \`typecheck\`,` }));
}

function problemsIn(root, path, ctx) {
  const text = readFileSync(join(root, path), "utf8");
  const name = posix.basename(path);
  if (name === "package.json") return manifestProblems(path, JSON.parse(text), ctx);
  const tokens = referencedTargets(path, text, ctx).filter((target) => target !== path).map((target) => ({ target, how: "it" }));
  return name === "turbo.json" ? [...turboProblems(path, JSON.parse(text), ctx), ...tokens] : tokens;
}

/**
 * R61 (TP-5200): only a package's `typecheck` script may name a tsconfig the fix-proof config carries.
 * A carried file counts as test support, so a build that read it would let a test-only change alter shipped output.
 * References are resolved to paths from every folder the reader may run from, so two packages may each carry their own file. A symlink to a carried file, a wildcard
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
  const packageDirs = files.filter((path) => posix.basename(path) === "package.json" && path !== "package.json").map((path) => posix.dirname(path));
  const ctx = { carried, compileGlobs, packageDirs };
  const readers = files.filter((path) => READER_FILE.test(path) && !isTest(path));
  const named = readers.flatMap((path) =>
    problemsIn(root, path, ctx).map(({ target, how }) => message(path, target, how)),
  );
  return [...links, ...named];
}
