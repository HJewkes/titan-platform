#!/usr/bin/env node
// Puts titan-factory on PATH: a symlink in a user bin directory that points at the built bin.
// Usage: node scripts/factory-link-bin.mjs [--bin-dir <dir>] [--force]
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_NAME = "titan-factory";

export function parseArgs(argv, home = homedir()) {
  const opts = { binDir: join(home, ".local", "bin"), force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--force") opts.force = true;
    else if (argv[i] === "--bin-dir" && argv[i + 1]) opts.binDir = resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}; usage: factory-link-bin [--bin-dir <dir>] [--force]`);
  }
  return opts;
}

/** What `link` is now: `absent`, a `file` that is no symlink, or the absolute path a symlink points at. */
function currentTarget(link) {
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (!stat) return "absent";
  return stat.isSymbolicLink() ? resolve(dirname(link), readlinkSync(link)) : "file";
}

/** A link that points at another checkout is someone's working install, so only --force repoints it. */
export function linkBin({ target, binDir, force }) {
  if (!existsSync(target)) throw new Error(`${target} is not built; run pnpm --filter "@titan-design/factory..." build`);
  const link = join(binDir, BIN_NAME);
  const current = currentTarget(link);
  if (current === target) return { link, status: "unchanged" };
  if (current === "file") throw new Error(`${link} exists and is not a symlink; remove it or pass --bin-dir`);
  if (current !== "absent" && !force) throw new Error(`${link} already points at ${current}; pass --force to repoint it at ${target}`);
  if (current !== "absent") unlinkSync(link);
  mkdirSync(binDir, { recursive: true });
  symlinkSync(target, link);
  return { link, status: current === "absent" ? "linked" : "repointed" };
}

export const onPath = (binDir, pathVar) => (pathVar ?? "").split(delimiter).some((entry) => entry !== "" && resolve(entry) === binDir);

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = join(ROOT, "products", "factory", "dist", "bin.js");
  const { link, status } = linkBin({ target, ...opts });
  console.log(`${status} ${link} -> ${target}`);
  if (!onPath(opts.binDir, process.env.PATH)) console.log(`${opts.binDir} is not on PATH; add it, e.g. export PATH="${opts.binDir}:$PATH"`);
  console.log("next: titan-factory service install --mcp");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}
