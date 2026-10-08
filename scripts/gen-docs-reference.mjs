#!/usr/bin/env node
/**
 * Emits the docs-site package reference index and its sidebar from the workspace,
 * so adding a package never needs a hand edit to the nav.
 *
 * Reads `.codewatch/check.json` (the DAG) and each package.json, writes
 * `site/reference/index.md` and `site/.vitepress/reference-sidebar.json`, and fills the
 * `<!-- generated:<name> start/end -->` blocks of the guides in MARKED_PAGES. Fails when a
 * package has no hand-written page under `site/reference/`. With `--check`, which
 * `docs:build` runs, it writes nothing and fails when a committed file differs from what it
 * would write or a package has no family in `site/guides/package-families.md`.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TIERS, findTiersRule } from "./new-package.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const TIER_LABELS = {
  0: { title: "Tier 0 — primitives", blurb: "Domain-free building blocks. No titan dependencies." },
  1: { title: "Tier 1 — engines", blurb: "Reusable machinery over the primitives." },
  2: { title: "Tier 2 — domain", blurb: "Modules that know about a subject: transcripts, code, rules." },
  ui: { title: "UI", blurb: "React bindings for the daemon wire. The design system, react-ui, is listed here but published from a separate repository." },
  product: { title: "Products", blurb: "Thin compositions of the tiers. Private, not published." },
};

/**
 * Published `@titan-design/*` packages that do not live in this workspace. They still
 * belong in the reference, so they are declared here rather than discovered.
 */
export const EXTERNAL = [
  {
    dir: "react-ui",
    tier: "ui",
    name: "@titan-design/react-ui",
    description: "Cross-platform design system built on React Native primitives with NativeWind",
    private: false,
    deps: [],
  },
];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`, { cause: error });
  }
}

/** `{ "packages/registry": "1", ... }` from the DAG rule that CI enforces. */
function tiersByDir(base) {
  const rule = findTiersRule(readJson(join(base, ".codewatch", "check.json")));
  if (!rule) throw new Error("check.json has no layered-deps rule with $tiers");
  const out = new Map();
  for (const [tier, dirs] of Object.entries(rule.$tiers)) {
    for (const dir of dirs) out.set(dir, tier);
  }
  return out;
}

/** Every workspace package, product and app, plus the published packages that live elsewhere. */
export function collect(base = root) {
  const tiers = tiersByDir(base);
  const entries = [];
  for (const group of ["packages", "products", "apps"]) {
    for (const dir of readdirSync(join(base, group)).sort()) {
      const manifest = join(base, group, dir, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = readJson(manifest);
      const tier = tiers.get(`${group}/${dir}`);
      if (tier === undefined) throw new Error(`${group}/${dir} is not in check.json $tiers`);
      entries.push({
        dir,
        group,
        tier,
        name: pkg.name,
        version: pkg.version,
        description: pkg.description ?? "",
        private: pkg.private === true,
        deps: Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@titan-design/")),
      });
    }
  }
  return [...entries, ...EXTERNAL];
}

function assertPagesExist(base, entries) {
  const pages = new Set(readdirSync(join(base, "site", "reference")).filter((f) => f.endsWith(".md")));
  const missing = entries.filter((e) => !e.private && !pages.has(`${e.dir}.md`)).map((e) => e.name);
  if (missing.length > 0) {
    throw new Error(`No reference page for: ${missing.join(", ")}. Add site/reference/<name>.md.`);
  }
}

const FAMILIES_PAGE = "site/guides/package-families.md";

/**
 * Every package under packages/, public or private, must be named in code font on the
 * families page. The families are prose, so this reports the gap rather than writing it.
 */
function familyGap(base, entries) {
  const text = readFileSync(join(base, FAMILIES_PAGE), "utf8");
  const missing = entries.filter((e) => e.group === "packages" && !text.includes(`\`${e.dir}\``)).map((e) => e.dir);
  if (missing.length === 0) return null;
  return `No package family for: ${missing.join(", ")}. Add each to a family in ${FAMILIES_PAGE}.`;
}

function sidebar(entries) {
  const groups = [];
  for (const tier of TIERS) {
    const label = TIER_LABELS[tier];
    const items = entries
      .filter((e) => String(e.tier) === tier && !e.private)
      .map((e) => ({ text: e.name.replace("@titan-design/", ""), link: `/reference/${e.dir}` }));
    if (items.length > 0) groups.push({ text: label.title, collapsed: false, items });
  }
  return groups;
}

function indexPage(entries) {
  const lines = [
    "<!-- Generated by scripts/gen-docs-reference.mjs. Do not edit. -->",
    "# Packages",
    "",
    "Every package below is published to npm under `@titan-design/` and versions independently.",
    "A package in this repo may import only its own tier or a lower one. Products are private",
    "compositions; the design system is published from a separate repository.",
    "",
  ];
  for (const tier of TIERS) {
    const label = TIER_LABELS[tier];
    const rows = entries.filter((e) => String(e.tier) === tier);
    if (rows.length === 0) continue;
    lines.push(`## ${label.title}`, "", label.blurb, "", "| Package | What it does | Titan dependencies |", "| --- | --- | --- |");
    for (const row of rows) {
      const short = row.name.replace("@titan-design/", "");
      const link = row.private ? `\`${short}\`` : `[\`${short}\`](/reference/${row.dir})`;
      const deps = row.deps.map((d) => `\`${d.replace("@titan-design/", "")}\``).join(", ") || "none";
      lines.push(`| ${link} | ${row.description} | ${deps} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const GRAPH_TITLES = {
  0: ["T0", "Tier 0 · primitives and contracts"],
  1: ["T1", "Tier 1 · engines"],
  2: ["T2", "Tier 2 · domain"],
  ui: ["UI", "UI"],
  product: ["P", "Products"],
};

/** Words mermaid's flowchart parser treats as keywords, so they cannot be node ids. */
const MERMAID_KEYWORDS = new Set(["cluster", "end", "graph", "subgraph", "style", "class", "click", "default"]);

const shortName = (name) => name.replace("@titan-design/", "");

function nodeId(dir) {
  const id = dir.replace(/-(\w)/g, (_, c) => c.toUpperCase());
  return MERMAID_KEYWORDS.has(id) ? `${id}Pkg` : id;
}

const NUMBER_WORDS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");
const numberWord = (n) => NUMBER_WORDS[n] ?? String(n);

function listProse(items) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/** Workspace units only: react-ui and deploy/hub sit outside the graph, as the page says. */
function archGraph(entries) {
  const units = entries.filter((e) => e.group !== undefined);
  const byName = new Map(units.map((e) => [e.name, e]));
  const lines = ["```mermaid", "graph TD"];
  for (const tier of TIERS) {
    const [id, title] = GRAPH_TITLES[tier];
    const members = units.filter((e) => String(e.tier) === tier);
    if (members.length === 0) continue;
    lines.push(`  subgraph ${id}["${title}"]`, ...members.map((e) => `    ${nodeId(e.dir)}["${e.dir}"]`), "  end");
  }
  lines.push("");
  for (const unit of units) {
    const targets = unit.deps.filter((d) => byName.has(d)).sort();
    lines.push(...targets.map((d) => `  ${nodeId(unit.dir)} --> ${nodeId(byName.get(d).dir)}`));
  }
  lines.push("```");
  return lines.join("\n");
}

function leavesProse(entries) {
  const leaves = TIERS.flatMap((tier) =>
    entries.filter((e) => e.group === "packages" && String(e.tier) === tier && e.deps.length === 0),
  );
  const names = leaves.map((e) => `\`${e.dir}\``);
  return `${listProse(names)} have no titan dependencies at all, which is why any of them can be adopted on its own.`;
}

function productsProse(entries) {
  const products = entries.filter((e) => e.tier === "product");
  const named = products.filter((e) => e.group !== "apps").map((e) => `\`${e.dir}\``);
  const apps = products.filter((e) => e.group === "apps").map((e) => `\`${e.dir}\``);
  if (apps.length === 1) named.push(`the ${apps[0]} app`);
  if (apps.length > 1) named.push(`the ${apps.length > 2 ? listProse(apps) : apps.join(" and ")} apps`);
  const units = `${numberWord(products.length)} unit${products.length === 1 ? "" : "s"}`;
  return `The \`product\` tier holds ${units}: ${listProse(named)}.`;
}

function minerCount(entries) {
  const miner = entries.find((e) => e.group === "products" && e.dir === "session-miner");
  if (!miner) throw new Error("products/session-miner is missing; the miner-count block has nothing to count");
  return numberWord(miner.deps.length);
}

/** Paragraph-level blocks sit on their own lines; `miner-count` sits inside a sentence. */
function blocks(entries) {
  return {
    "arch-graph": `\n${archGraph(entries)}\n`,
    "arch-leaves": `\n${leavesProse(entries)}\n`,
    "arch-products": `\n${productsProse(entries)}\n`,
    "miner-count": minerCount(entries),
  };
}

export const MARKED_PAGES = {
  "site/guides/architecture.md": ["arch-graph", "arch-leaves", "arch-products", "miner-count"],
  "site/guides/index.md": ["miner-count"],
};

function fillMarkers(text, page, generated) {
  let out = text;
  for (const name of MARKED_PAGES[page]) {
    const pattern = new RegExp(`(<!-- generated:${name} start -->)[\\s\\S]*?(<!-- generated:${name} end -->)`, "g");
    if (!out.match(pattern)) throw new Error(`${page} has no <!-- generated:${name} start/end --> markers`);
    out = out.replace(pattern, (_, start, end) => `${start}${generated[name]}${end}`);
  }
  return out;
}

/** Every file this script owns, as `{ path, content }` relative to `base`. */
export function outputs(base = root) {
  const entries = collect(base);
  assertPagesExist(base, entries);
  const generated = blocks(entries);
  const marked = Object.keys(MARKED_PAGES).map((page) => ({
    path: page,
    content: fillMarkers(readFileSync(join(base, page), "utf8"), page, generated),
  }));
  return [
    { path: "site/.vitepress/reference-sidebar.json", content: JSON.stringify(sidebar(entries), null, 2) + "\n" },
    { path: "site/reference/index.md", content: indexPage(entries) },
    ...marked,
  ];
}

/** What `--check` fails on: committed files that differ from `outputs`, and a package with no family. */
export function problems(base = root) {
  const stale = outputs(base)
    .filter(({ path, content }) => !existsSync(join(base, path)) || readFileSync(join(base, path), "utf8") !== content)
    .map(({ path }) => path);
  const found = [];
  if (stale.length > 0) found.push(`Generated docs are out of date: ${stale.join(", ")}. Run \`pnpm docs:reference\` and commit the result.`);
  const gap = familyGap(base, collect(base));
  if (gap) found.push(gap);
  return found;
}

function main(argv) {
  if (argv.includes("--check")) {
    const found = problems();
    for (const problem of found) console.error(problem);
    if (found.length > 0) process.exit(1);
    console.log("reference: generated docs are up to date");
    return;
  }
  const files = outputs();
  for (const { path, content } of files) writeFileSync(join(root, path), content);
  const gap = familyGap(root, collect());
  if (gap) console.warn(`${gap} docs:build fails until then.`);
  console.log(`reference: wrote ${files.length} generated files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
