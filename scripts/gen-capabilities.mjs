#!/usr/bin/env node
/**
 * Emits the capability catalog, the first stop before building anything here: every package,
 * product and app with its purpose, key exports and a hand-written "use this when" line.
 *
 * Package discovery is shared with gen-docs-reference.mjs. The "use this when" line lives in
 * each unit's CAPABILITY.md; runtime paths and known gaps live in scripts/capabilities-data.json.
 * `--check` regenerates in memory and exits 1 when a committed copy is stale.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TIER_LABELS, collect } from "./gen-docs-reference.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE_URL = "https://hjewkes.github.io/titan-platform";
const KEY_EXPORT_CAP = 12;
const EXPORT_FROM = /export\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const EXPORT_STAR = /export\s+\*\s+from\s*["']([^"']+)["']/g;
const EXPORT_DECL = /^export\s+(?:declare\s+)?(async\s+function|function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const TYPE_DECLS = new Set(["interface", "type"]);

/** Every name a module exports, with the module it re-exports from; `export *` goes through `resolveStar`. */
export function parseExports(source, resolveStar = () => []) {
  const out = [];
  for (const [, typeOnly, list, from] of source.matchAll(EXPORT_FROM)) {
    for (const raw of list.split(",").map((s) => s.trim()).filter(Boolean)) {
      const isType = Boolean(typeOnly) || raw.startsWith("type ");
      const name = raw.replace(/^type\s+/, "").split(/\s+as\s+/).pop();
      out.push({ name, type: isType, from });
    }
  }
  for (const [, from] of source.matchAll(EXPORT_STAR)) {
    out.push(...resolveStar(from).map((e) => ({ ...e, from })));
  }
  for (const [, kind, name] of source.matchAll(EXPORT_DECL)) {
    out.push({ name, type: TYPE_DECLS.has(kind), from: "./index.js" });
  }
  return out;
}

function readExports(file, seen = new Set()) {
  if (!existsSync(file) || seen.has(file)) return [];
  seen.add(file);
  const resolveStar = (spec) => readExports(join(dirname(file), spec.replace(/\.js$/, ".ts")), seen);
  return parseExports(readFileSync(file, "utf8"), resolveStar);
}

/** Runtime values before types, callables before SCREAMING_CASE constants; source order breaks ties. */
function rank(entry) {
  if (entry.type) return 2;
  return /^[A-Z][A-Z0-9_]+$/.test(entry.name) ? 1 : 0;
}

function concern(from) {
  return from.replace(/^\.\//, "").replace(/\.js$/, "").replace(/\/index$/, "");
}

/** The top exports grouped by the module they come from, plus how many were left out. */
export function keyExports(entries, cap = KEY_EXPORT_CAP) {
  const unique = [...new Map(entries.map((e) => [e.name, e])).values()];
  const picked = new Set(
    unique
      .map((e, i) => ({ e, i }))
      .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
      .slice(0, cap)
      .map(({ e }) => e),
  );
  const groups = new Map();
  for (const entry of unique.filter((e) => picked.has(e))) {
    const key = concern(entry.from);
    groups.set(key, [...(groups.get(key) ?? []), entry.name]);
  }
  return { groups: [...groups].map(([name, names]) => ({ concern: name, names })), more: unique.length - picked.size };
}

/** The body of a CAPABILITY.md: everything but headings and comments, on one line. */
export function parseUseWhen(markdown) {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.trim())
    .join(" ");
}

function useWhenFor(entry, data) {
  if (!entry.group) return data.external[entry.dir] ?? "";
  const file = join(root, entry.group, entry.dir, "CAPABILITY.md");
  if (!existsSync(file)) throw new Error(`${entry.group}/${entry.dir} has no CAPABILITY.md. Say when a reader should reach for it.`);
  return parseUseWhen(readFileSync(file, "utf8"));
}

function enrich(entry, data) {
  const index = entry.group ? join(root, entry.group, entry.dir, "src", "index.ts") : "";
  return { ...entry, useWhen: useWhenFor(entry, data), exports: keyExports(readExports(index)) };
}

const siteLinks = { reference: (dir) => `/reference/${dir}`, guide: (name) => `/guides/${name}` };
const repoLinks = { reference: (dir) => `${SITE_URL}/reference/${dir}`, guide: (name) => `${SITE_URL}/guides/${name}` };

function shortName(entry) {
  return entry.name.replace("@titan-design/", "");
}

function anchor(entry) {
  return `cap-${entry.dir}`;
}

function byTier(entries) {
  const order = Object.keys(TIER_LABELS);
  return entries.map((e, i) => ({ e, i })).sort((a, b) => order.indexOf(String(a.e.tier)) - order.indexOf(String(b.e.tier)) || a.i - b.i).map(({ e }) => e);
}

function quickIndex(entries) {
  const lines = ["## Quick index", "", "| Unit | Tier | Use this when |", "| --- | --- | --- |"];
  for (const e of byTier(entries)) lines.push(`| [\`${shortName(e)}\`](#${anchor(e)}) | ${e.tier} | ${e.useWhen.replaceAll("|", "\\|")} |`);
  return [...lines, ""];
}

function distribution(entry) {
  if (!entry.group) return `\`${entry.name}\`, published from the titan-design repository`;
  if (entry.private) return `private, \`${entry.group}/${entry.dir}\``;
  return `\`${entry.name}@${entry.version}\``;
}

function exportLines(entry, links) {
  const { groups, more } = entry.exports;
  if (groups.length === 0) return ["No library entry point."];
  const lines = groups.map((g) => `- \`${g.concern}\`: ${g.names.map((n) => `\`${n}\``).join(", ")}`);
  if (more > 0) {
    lines.push(entry.private ? `- +${more} more in \`${entry.group}/${entry.dir}/src/index.ts\`` : `- +${more} more in the [reference page](${links.reference(entry.dir)})`);
  }
  return lines;
}

function unitSection(entry, links) {
  const title = entry.private || !entry.group ? `\`${shortName(entry)}\`` : `[\`${shortName(entry)}\`](${links.reference(entry.dir)})`;
  return [
    `<a id="${anchor(entry)}"></a>`,
    "",
    `### ${title}`,
    "",
    `Tier ${entry.tier}, ${distribution(entry)}. ${entry.description}`,
    "",
    `**Use this when:** ${entry.useWhen}`,
    "",
    ...(entry.group ? ["Key exports:", "", ...exportLines(entry, links), ""] : []),
  ];
}

function tierSections(entries, links) {
  const lines = [];
  for (const [tier, label] of Object.entries(TIER_LABELS)) {
    const rows = entries.filter((e) => String(e.tier) === tier);
    if (rows.length === 0) continue;
    lines.push(`## ${label.title}`, "", label.blurb, "");
    for (const row of rows) lines.push(...unitSection(row, links));
  }
  return lines;
}

function runtimeSection(data) {
  const lines = [
    "## Proven runtime paths",
    "",
    "Each path below runs a model or an external tool. Check the credential before you design",
    "around a path, and run its smoke check in the environment the job will really use.",
    "",
    "| Path | Package | Credential it needs | Smoke check |",
    "| --- | --- | --- | --- |",
  ];
  for (const p of data.runtimePaths) lines.push(`| ${p.path} | \`${p.package}\` | ${p.credential} | ${p.smoke} |`);
  return [...lines, ""];
}

function gapsSection(data) {
  const lines = [
    "## Known gaps",
    "",
    "Capabilities people have asked for that no unit provides yet. If your plan needs one, build it",
    "under its task instead of inside a product. Edit the list in `scripts/capabilities-data.json`.",
    "",
    "| Task | Area | Gap |",
    "| --- | --- | --- |",
  ];
  for (const g of data.knownGaps) lines.push(`| ${g.id} | \`${g.package}\` | ${g.title} |`);
  return [...lines, ""];
}

function header(links) {
  return [
    "<!-- Generated by scripts/gen-capabilities.mjs from package.json, src/index.ts, CAPABILITY.md and scripts/capabilities-data.json. Run `pnpm capabilities`; do not edit. -->",
    "# Capability catalog",
    "",
    "Read this before you build. Every unit in titan-platform is listed with what it is for, when",
    "to reach for it, and its main exports. If a unit already does what you need, use it. If one",
    "almost fits, file a task naming the missing export (see",
    `[where code goes](${links.guide("where-code-goes")})). Then check the runtime paths: the credential a`,
    "path needs decides whether it works where your job runs.",
    "",
    "Before adding code:",
    "",
    "1. Read this catalog and the reference page of every unit that looks close.",
    "2. Name the existing unit you reuse, or the gap you fill and its task.",
    "3. Verify runtime and auth assumptions with the path's smoke check before you build on them.",
    "",
  ];
}

export function render(entries, data, links) {
  return [...header(links), ...quickIndex(entries), ...runtimeSection(data), ...gapsSection(data), ...tierSections(entries, links)].join("\n");
}

function outputs() {
  const data = JSON.parse(readFileSync(join(root, "scripts", "capabilities-data.json"), "utf8"));
  const entries = collect().map((e) => enrich(e, data));
  return [
    { path: join(root, "CAPABILITIES.md"), text: render(entries, data, repoLinks) },
    { path: join(root, "site", "guides", "capabilities.md"), text: render(entries, data, siteLinks) },
  ];
}

function main() {
  const files = outputs();
  if (process.argv.includes("--check")) {
    const stale = files.filter((f) => !existsSync(f.path) || readFileSync(f.path, "utf8") !== f.text);
    for (const f of stale) console.error(`stale: ${f.path.slice(root.length + 1)}. Run pnpm capabilities and commit the result.`);
    process.exit(stale.length > 0 ? 1 : 0);
  }
  for (const f of files) writeFileSync(f.path, f.text);
  console.log(`capabilities: ${files.length} files, ${collect().length} units`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
