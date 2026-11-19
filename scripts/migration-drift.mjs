// Migration drift check (TP-6140): a migration that declares `definition` is pinned by the hash in
// migration-drift.json, so editing one that has shipped fails CI instead of silently diverging
// databases that already applied it. A migration with no definition is skipped.
// `node scripts/migration-drift.mjs` checks; `--update` records hashes of migrations not yet pinned and never rewrites a pinned one.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "scripts/migration-drift.json");

/** @returns {{ edited: string[], unpinned: { id: string, version: number, hash: string }[] }} */
export function findDrift(hashes, listsById, definitionHash) {
  const edited = [];
  const unpinned = [];
  for (const [id, migrations] of Object.entries(listsById)) {
    for (const m of migrations) {
      const hash = definitionHash(m);
      if (hash === null) continue;
      const pinned = hashes[id]?.[String(m.version)];
      if (pinned === undefined) unpinned.push({ id, version: m.version, hash });
      else if (pinned !== hash) edited.push(`${id} version ${m.version}: pinned ${pinned}, now ${hash}`);
    }
  }
  return { edited, unpinned };
}

export function pinUnpinned(hashes, unpinned) {
  const next = structuredClone(hashes);
  for (const { id, version, hash } of unpinned) (next[id] ??= {})[String(version)] = hash;
  return next;
}

async function loadLists(config) {
  const entries = await Promise.all(
    config.lists.map(async ({ id, module, export: name }) => [id, (await import(pathToFileURL(join(root, module)).href))[name]]),
  );
  return Object.fromEntries(entries);
}

async function main(update) {
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const { definitionHash } = await import(pathToFileURL(join(root, "packages/store-sqlite/dist/index.js")).href);
  const { edited, unpinned } = findDrift(config.hashes, await loadLists(config), definitionHash);
  for (const line of edited) console.error(`migration-drift: edited after it shipped: ${line}; add a new migration instead`);
  if (edited.length > 0) return 1;
  if (unpinned.length === 0) return 0;
  if (!update) {
    for (const u of unpinned) console.error(`migration-drift: ${u.id} version ${u.version} is not pinned; run node scripts/migration-drift.mjs --update`);
    return 1;
  }
  writeFileSync(configPath, `${JSON.stringify({ ...config, hashes: pinUnpinned(config.hashes, unpinned) }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.includes("--update"));
