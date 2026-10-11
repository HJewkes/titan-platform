#!/usr/bin/env node
// Stamp a new workspace package from templates/package and register its tier in check.json.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_JSON = join(ROOT, ".codewatch", "check.json");
export const TIERS = ["0", "1", "2", "ui", "product"];

/** The rule in a parsed check.json that carries `$tiers`, the source of truth for the DAG. */
export function findTiersRule(config) {
  return config.rules.find((r) => r.type === "layered-deps" && r.$tiers);
}

export function parseArgs(argv) {
  const [name, ...rest] = argv;
  const opts = { name, tier: undefined, description: "", task: "an untracked task" };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, "");
    if (key in opts) opts[key] = rest[i + 1];
  }
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid package name: ${name}`);
  if (!TIERS.includes(opts.tier)) throw new Error(`--tier must be one of ${TIERS.join("|")}`);
  return opts;
}

function substitute(dir, vars) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      substitute(path, vars);
      continue;
    }
    let text = readFileSync(path, "utf8");
    for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`__${key}__`, value);
    writeFileSync(path, text);
  }
}

// codewatch rejects empty layers, so `$tiers` holds the full tier list and `layers` drops empties.
export function registerLayer(checkJsonText, prefix, tier) {
  const config = JSON.parse(checkJsonText);
  const rule = findTiersRule(config);
  if (!rule?.$tiers) throw new Error("check.json needs a layered-deps rule with $tiers");
  const tierPackages = (rule.$tiers[tier] ??= []);
  if (!tierPackages.includes(prefix)) tierPackages.push(prefix);
  rule.layers = layersFromTiers(rule.$tiers);
  const others = config.rules.filter((r) => !r.id?.startsWith(PRODUCT_ISOLATION));
  const at = others.indexOf(rule) + 1;
  config.rules = [...others.slice(0, at), ...productIsolationRules(rule.$tiers.product), ...others.slice(at)];
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function layersFromTiers(tiers) {
  return TIERS.map((t) => tiers[t] ?? []).filter((layer) => layer.length > 0);
}

const PRODUCT_ISOLATION = "product-isolation:";

// Products share one layer, and layered-deps allows same-layer imports. forbid-import has no
// negation, so each ordered pair of products gets its own rule.
export function productIsolationRules(products = []) {
  return products.flatMap((from) =>
    products
      .filter((to) => to !== from)
      .map((to) => ({
        id: `${PRODUCT_ISOLATION}${from}->${to}`,
        type: "forbid-import",
        $comment: "Products talk over a CLI, loopback HTTP or MCP. Move the shared code to a package.",
        from: `${from}/**`,
        to: `${to}/**`,
      })),
  );
}

/**
 * Writes the reference page the docs build demands for every public package. Returns the
 * path when it stamped one, and null when a page is already there — a re-stamp must never
 * flatten a hand-written page.
 */
export function stampReferencePage(root, opts) {
  const page = join(root, "site", "reference", `${opts.name}.md`);
  if (existsSync(page)) return null;
  let text = readFileSync(join(root, "templates", "reference-page.md"), "utf8");
  const vars = { NAME: opts.name, TIER: String(opts.tier), DESCRIPTION: opts.description, TASK: opts.task };
  for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`__${key}__`, value);
  writeFileSync(page, text);
  return page;
}

/** Copies templates/package into `<dir>/<name>` with the placeholders filled in, CAPABILITY.md included. */
export function stampPackageDir(root, opts) {
  const dir = opts.tier === "product" ? "products" : "packages";
  const dest = join(root, dir, opts.name);
  cpSync(join(root, "templates", "package"), dest, { recursive: true, errorOnExist: true, force: false });
  substitute(dest, { NAME: opts.name, DIR: dir, TIER: String(opts.tier), DESCRIPTION: opts.description, TASK: opts.task });
  return { dir, dest };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { dir } = stampPackageDir(ROOT, opts);
  writeFileSync(CHECK_JSON, registerLayer(readFileSync(CHECK_JSON, "utf8"), `${dir}/${opts.name}`, opts.tier));
  const page = stampReferencePage(ROOT, opts);
  execFileSync(process.execPath, [join(ROOT, "scripts", "gen-docs-reference.mjs")], { stdio: "inherit" });
  execFileSync(process.execPath, [join(ROOT, "scripts", "gen-capabilities.mjs")], { stdio: "inherit" });
  console.log(`created ${dir}/${opts.name} (tier ${opts.tier})${page ? ` and site/reference/${opts.name}.md` : ""}; fill in its CAPABILITY.md`);
  console.log(areasReminder(opts.name));
}

/** Each package is a task area, and the registry lives outside this repo, so new:package can only remind. */
export const areasReminder = (name) =>
  `new area \`${name}\`: run \`pnpm areas --write <categories.yml>\` to add it to the task category registry`;

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
