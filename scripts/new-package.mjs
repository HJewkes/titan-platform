#!/usr/bin/env node
// Stamp a new workspace package from templates/package and register its tier in check.json.
import { cpSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "templates", "package");
const CHECK_JSON = join(ROOT, ".codewatch", "check.json");
const TIER_ORDER = ["0", "1", "2", "ui", "product"];

export function parseArgs(argv) {
  const [name, ...rest] = argv;
  const opts = { name, tier: undefined, description: "", task: "an untracked task" };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, "");
    if (key in opts) opts[key] = rest[i + 1];
  }
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid package name: ${name}`);
  if (!TIER_ORDER.includes(opts.tier)) throw new Error(`--tier must be one of ${TIER_ORDER.join("|")}`);
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
  const rule = config.rules.find((r) => r.type === "layered-deps");
  if (!rule?.$tiers) throw new Error("check.json needs a layered-deps rule with $tiers");
  const tierPackages = (rule.$tiers[tier] ??= []);
  if (!tierPackages.includes(prefix)) tierPackages.push(prefix);
  rule.layers = TIER_ORDER.map((t) => rule.$tiers[t] ?? []).filter((layer) => layer.length > 0);
  return `${JSON.stringify(config, null, 2)}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts.tier === "product" ? "products" : "packages";
  const dest = join(ROOT, dir, opts.name);
  cpSync(TEMPLATE, dest, { recursive: true, errorOnExist: true, force: false });
  substitute(dest, { NAME: opts.name, DIR: dir, TIER: String(opts.tier), DESCRIPTION: opts.description, TASK: opts.task });
  writeFileSync(CHECK_JSON, registerLayer(readFileSync(CHECK_JSON, "utf8"), `${dir}/${opts.name}`, opts.tier));
  console.log(`created ${dir}/${opts.name} (tier ${opts.tier})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
