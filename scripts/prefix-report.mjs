// TP-4374 prefix report: reads the first API request of every named session from the last N days and prints how much of
// it was read from cache, whether the system[2] prefix would have been warm, and where pairs of requests first differ.
// Needs `pnpm build`: it imports the built session-read and session-analytics.
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const options = { days: 7, pairs: 200, windowMin: 60 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { "--days": "days", "--pairs": "pairs", "--window-min": "windowMin" }[argv[i]];
    const value = Number(argv[i + 1]);
    if (!key || !Number.isFinite(value) || value <= 0) throw new Error(`usage: prefix-report [--days n] [--pairs n] [--window-min n]; got ${argv[i]} ${argv[i + 1] ?? ""}`);
    options[key] = value;
  }
  return options;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const num = (x) => Math.round(x).toLocaleString("en-US");

export function renderReport(reuse, options) {
  const lines = [
    `# Prefix report: first requests of ${reuse.sessions} named sessions, last ${options.days} d`,
    "",
    `- measured with usage: ${reuse.measured}`,
    `- token-weighted cache-read share: ${pct(reuse.tokenShare)}; median share ${pct(reuse.medianShare)}`,
    `- median first-call tokens: ${num(reuse.medianFirstCallTokens)}`,
    `- first calls with share >= 60%: ${reuse.atLeast60}; >= 70%: ${reuse.atLeast70}`,
    `- first-call input spend at list price: $${reuse.inputUsd.toFixed(2)}`,
    `- system[2] hit within ${options.windowMin} min: ${reuse.hit.hits}/${reuse.hit.total} (${pct(reuse.hit.rate)})`,
    "",
    `## First divergence over ${reuse.divergence.pairs} pairs (${reuse.divergence.identical} identical)`,
    "",
    "| block | pairs | median absolute byte |",
    "|---|---:|---:|",
    ...reuse.divergence.byBlock.map((g) => `| \`${g.path}\` | ${g.pairs} | ${num(g.medianAbsoluteByte)} |`),
    "",
    "## Cache breakpoints",
    "",
    "| layout | sessions |",
    "|---|---:|",
    ...reuse.cacheControl.map((c) => `| ${c.signature || "(none)"} | ${c.sessions} |`),
  ];
  return lines.join("\n");
}

async function loadRows(days, session) {
  const since = Date.now() - days * DAY_MS;
  const transcripts = (await session.discoverAllTranscripts()).filter((t) => t.subagentId === null && statSync(t.absolutePath).mtimeMs >= since);
  const rows = [];
  for (const transcript of transcripts) {
    const first = await session.readFirstRequest(transcript.absolutePath);
    if (first?.agentName) rows.push({ ...first, account: transcript.account ?? "default" });
  }
  return rows;
}

async function main(argv) {
  const options = parseArgs(argv);
  const load = (pkg) => import(pathToFileURL(path.join(root, "packages", pkg, "dist", "index.js")).href);
  const [session, analytics] = [await load("session-read"), await load("session-analytics")];
  const rows = await loadRows(options.days, session);
  console.log(renderReport(analytics.prefixReuse(rows, options), options));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
