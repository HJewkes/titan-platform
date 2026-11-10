// Structure rules that read the fix-proof config. Split from structure-rules.mjs to stay under the file cap.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, posix, relative, sep } from "node:path";

const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".worktrees"]);
const CONFIG_FILE = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|[^/]+\.config\.[cm]?[jt]s|\.github\/workflows\/[^/]+\.ya?ml)$/;

function configFiles(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : configFiles(root, path);
    return entry.isFile() ? [relative(root, path).split(sep).join("/")] : [];
  }).filter((path) => CONFIG_FILE.test(path));
}

// A package.json may name the file only in its own `typecheck` script; every other script is a reference.
function manifestReferences(text, name, ownTypecheck) {
  const scripts = JSON.parse(text).scripts ?? {};
  return Object.entries(scripts).some(([key, value]) => String(value).includes(name) && !(key === "typecheck" && ownTypecheck));
}

function namesCarried(root, path, carried) {
  const text = readFileSync(join(root, path), "utf8");
  return carried.filter((target) => {
    const name = posix.basename(target);
    if (path === target || !text.includes(name)) return false;
    return basename(path) === "package.json"
      ? manifestReferences(text, name, posix.dirname(path) === posix.dirname(target))
      : true;
  });
}

/**
 * R61 (TP-5200): only a package's `typecheck` script may name a tsconfig the fix-proof config carries.
 * A carried file counts as test support, so a build that read it would let a test-only change alter shipped output.
 */
export async function checkCarriedTsconfigReferences(root) {
  const { compileGlobs, parseFixProofConfig, CONFIG_PATH } = await import("../packages/fix-proof/dist/index.js");
  const parsed = parseFixProofConfig(existsSync(join(root, CONFIG_PATH)) ? readFileSync(join(root, CONFIG_PATH), "utf8") : null);
  if (!parsed.ok) return [parsed.error];
  const isCarried = compileGlobs(parsed.config.carry);
  const files = configFiles(root).filter((path) => path !== CONFIG_PATH);
  // A plain `tsconfig.json` under a fixtures glob is carried too, but every package names its own by that basename, so a basename match cannot tell them apart.
  const carried = files.filter((path) => /^tsconfig\..+\.json$/.test(posix.basename(path)) && isCarried(path));
  return files.flatMap((path) =>
    namesCarried(root, path, carried).map(
      (target) => `\`${path}\` names \`${target}\`, which \`${CONFIG_PATH}\` carries as test support. Only a package \`typecheck\` script may; a build that read it would let a test-only change alter shipped output (R61, TP-5200).`,
    ),
  );
}
