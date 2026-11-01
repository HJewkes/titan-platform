#!/usr/bin/env node
/**
 * Generate `docs/cli-reference.md` by walking `active-work --help` and capturing
 * `--help` output for every leaf sub-command.
 *
 * Usage:
 *   node scripts/gen-cli-reference.mjs            # writes docs/cli-reference.md
 *   node scripts/gen-cli-reference.mjs --stdout   # prints to stdout
 *
 * Requires `pnpm build` to have run so `dist/program.js` exists.
 */
import { writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PROGRAM = resolve(REPO_ROOT, 'dist/program.js');
const OUT = resolve(REPO_ROOT, 'docs/cli-reference.md');
const SRC = resolve(REPO_ROOT, 'src');

if (!existsSync(PROGRAM)) {
  console.error(`error: ${PROGRAM} not found. Run \`pnpm build\` first.`);
  process.exit(1);
}

/** Recursively find the most recent mtime among files under `dir`. */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

const distMtime = statSync(PROGRAM).mtimeMs;
const srcMtime = newestMtime(SRC);
if (srcMtime > distMtime) {
  console.error(
    `error: ${PROGRAM} is older than src/ (dist stale). Run \`pnpm build:cli\` before regenerating docs.`,
  );
  process.exit(1);
}

// Imported, not spawned per command: one node start per command cost ~0.25 s each, ~100 times over.
const { buildProgram } = await import(pathToFileURL(PROGRAM).href);
const program = buildProgram();

/** Render a command's `--help` in process, as a piped, colourless run of the built CLI would print it. */
function runHelp(args) {
  let command = program;
  for (const name of args) command = command.commands.find((c) => c.name() === name);
  let out = '';
  command.configureOutput({
    writeOut: (text) => (out += text),
    getOutHelpWidth: () => 80,
    getOutHasColors: () => false,
  });
  command.outputHelp();
  return out.trimEnd();
}

/**
 * Parse a `Commands:` block out of a help blob. Each entry is one or more
 * lines: the first starts with two-space indent, then the command name,
 * then a description that may wrap to subsequent indented lines.
 *
 * Returns an array of `{ name, description }`. Sub-command groups (their
 * description is exactly `<name> commands`) are flagged via `isGroup`.
 */
function parseCommands(helpText) {
  const lines = helpText.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === 'Commands:');
  if (startIdx === -1) return [];

  const entries = [];
  let current = null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    // Lines starting with two spaces and a letter begin a new command;
    // subsequent indented continuation lines extend the description.
    const match = line.match(/^ {2}([a-z][a-z0-9-]*)(?:\s+\[options])?(?:\s+[^ ].*?)?\s{2,}(.*)$/);
    if (match) {
      if (current) entries.push(current);
      current = { name: match[1], description: match[2].trim() };
    } else if (current && /^\s{4,}/.test(line)) {
      current.description += ' ' + line.trim();
    }
  }
  if (current) entries.push(current);
  return withoutHelp(entries);
}

function withoutHelp(entries) {
  return entries
    .filter((e) => e.name !== 'help')
    .map((e) => ({ ...e, isGroup: /^[a-z]+ commands$/.test(e.description) }));
}

/**
 * Walk help recursively to enumerate every leaf command path.
 * A leaf is any command whose own help has no `Commands:` section
 * (or only `help` as a sub-command).
 */
function enumerateLeaves(prefix = []) {
  const help = runHelp(prefix);
  const cmds = parseCommands(help);
  if (cmds.length === 0) {
    // Leaf — return the prefix itself (or empty for root with no children).
    return prefix.length === 0 ? [] : [prefix];
  }
  const leaves = [];
  for (const cmd of cmds) {
    leaves.push(...enumerateLeaves([...prefix, cmd.name]));
  }
  return leaves;
}

function renderReference() {
  const header = `# CLI reference

Generated from \`active-work --help\` and individual command \`--help\` outputs.
Re-run \`node scripts/gen-cli-reference.mjs\` to refresh after the CLI
surface changes.

`;

  const rootHelp = runHelp([]);
  const sections = [
    `## active-work\n\nTop-level help. Run \`active-work <command> --help\` for command-specific options.\n\n\`\`\`\n${rootHelp}\n\`\`\`\n`,
  ];

  const leaves = enumerateLeaves();
  // Sort alphabetically by joined path.
  leaves.sort((a, b) => a.join(' ').localeCompare(b.join(' ')));

  for (const leaf of leaves) {
    const path = leaf.join(' ');
    const help = runHelp(leaf);
    sections.push(`## active-work ${path}\n\n\`\`\`\n${help}\n\`\`\`\n`);
  }

  return header + sections.join('\n');
}

const out = renderReference();

if (process.argv.includes('--stdout')) {
  process.stdout.write(out);
} else {
  writeFileSync(OUT, out, 'utf8');
  process.stderr.write(`wrote ${OUT}\n`);
}
