// A worktree under .worktrees/ with no node_modules of its own resolves packages from the main checkout above it,
// whose install can be days behind this lockfile; tests then run silently on the wrong versions (TP-2781).
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

function findPackageJson(name, from) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Null when `name` resolves into `<root>/node_modules`, otherwise a message saying where it resolved and how to fix it.
 * The package is compared after realpath, so pnpm's links into node_modules/.pnpm count as the checkout's own and a
 * link into another checkout's node_modules does not.
 */
export function strayDependency(root, name, resolveFrom = root) {
  const fix = `run \`pnpm install --frozen-lockfile\` in ${root}`;
  const found = findPackageJson(name, resolveFrom);
  if (!found) return `${name} is not installed for ${root}: ${fix}.`;
  const ownModules = path.join(root, "node_modules");
  const resolved = realpathSync(found);
  if (isInside(resolved, path.join(realpathSync(root), "node_modules"))) return null;
  return `${name} resolved to ${resolved}, outside ${ownModules}; it may not match this checkout's lockfile: ${fix}.`;
}
