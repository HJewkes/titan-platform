#!/usr/bin/env node
// Replays the last N days of task creation against the task-add checks (TP-2544), to calibrate
// the possible-dup threshold. It writes nothing: the report goes to stdout as markdown.
//
//   node scripts/task-add-replay.mjs --root <active root> [--days 14] [--sample 20] [--now <iso>]
//
// --root defaults to $ACTIVE_ROOT; there is no other default, so it never reads a root by accident.
// Run it from a checkout: it imports the gate from src, which the published package does not ship.
//
// Counts are an upper bound on what the gate would refuse, because a task records no caller and
// the gate only applies to agents.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { jaccard, tokenize } from '@titan-design/memory';
import { doneWhenProblem } from '../src/commands/_done-when-gate.ts';

const DAY_MS = 86_400_000;
export const THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

const idNumber = (task) => Number(task.id.split('-').pop());

/** Date-only `created` values tie within a day, so the id decides which was filed first. */
function filedBefore(a, b) {
  const delta = Date.parse(a.created) - Date.parse(b.created);
  return delta < 0 || (delta === 0 && idNumber(a) < idNumber(b));
}

function openAt(task, when) {
  if (task.done_at) return Date.parse(task.done_at) > when;
  return task.status === 'open';
}

function sharesToken(a, b) {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

/** The band a score falls in, or -1 below the lowest threshold. */
const bandOf = (score) => THRESHOLDS.findLastIndex((threshold) => score >= threshold);

function bandLabel(band) {
  const upper = band === THRESHOLDS.length - 1 ? 1 : THRESHOLDS[band + 1];
  return `${THRESHOLDS[band].toFixed(1)}-${upper.toFixed(1)}`;
}

/** Earlier open tasks whose title scores at least the lowest threshold against this task's. */
function pairsFor(task, tokens, slugTasks) {
  const pairs = [];
  const when = Date.parse(task.created);
  for (const other of slugTasks) {
    if (!filedBefore(other, task) || !openAt(other, when)) continue;
    // Skips the jaccard call for a disjoint pair, most of them, and its 1.0 for two empty sets.
    if (!sharesToken(tokens.get(task), tokens.get(other))) continue;
    const score = jaccard(task.title, other.title);
    const band = bandOf(score);
    if (band >= 0) pairs.push({ task, other, score, band });
  }
  return pairs;
}

const sampleKey = (pair) => createHash('sha256').update(`${pair.task.id}|${pair.other.id}`).digest('hex');

function sampleBand(pairs, size) {
  const keyed = pairs.map((pair) => [sampleKey(pair), pair]);
  keyed.sort(([a], [b]) => a.localeCompare(b));
  return keyed.slice(0, size).map(([, pair]) => ({
    score: Number(pair.score.toFixed(3)),
    id: pair.task.id,
    title: pair.task.title,
    earlier_id: pair.other.id,
    earlier_title: pair.other.title,
  }));
}

function countRefusals(tasks) {
  const refused = {};
  for (const task of tasks) {
    const problem = doneWhenProblem(task.title, task.done_when);
    if (problem === undefined) continue;
    const reason = problem.split(':')[0];
    refused[reason] = (refused[reason] ?? 0) + 1;
  }
  return refused;
}

function summarizeBands(pairs, inWindow, sample) {
  return THRESHOLDS.map((threshold, band) => {
    const above = pairs.filter((pair) => pair.band >= band);
    const inBand = pairs.filter((pair) => pair.band === band);
    const flagged = new Set(above.map((pair) => pair.task)).size;
    return {
      threshold,
      flagged_tasks: flagged,
      flagged_pct: inWindow === 0 ? 0 : Number(((100 * flagged) / inWindow).toFixed(1)),
      pairs_at_or_above: above.length,
      band: bandLabel(band),
      pairs_in_band: inBand.length,
      sampled: sampleBand(inBand, sample),
    };
  });
}

/** Replays creation over `bySlug` (slug -> tasks). Pure, so a fixture can pin its counts. */
export function replay(bySlug, { now, days = 14, sample = 20 }) {
  const since = now - days * DAY_MS;
  const inWindow = [];
  const pairs = [];
  for (const slugTasks of bySlug.values()) {
    const tokens = new Map(slugTasks.map((task) => [task, tokenize(task.title)]));
    for (const task of slugTasks) {
      const created = Date.parse(task.created);
      if (created < since || created > now) continue;
      inWindow.push(task);
      pairs.push(...pairsFor(task, tokens, slugTasks));
    }
  }
  return {
    window_days: days,
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    tasks_in_window: inWindow.length,
    refused: countRefusals(inWindow),
    bands: summarizeBands(pairs, inWindow.length, sample),
  };
}

async function readTask(file) {
  try {
    const task = YAML.parse(await fs.readFile(file, 'utf8'));
    const usable = typeof task?.id === 'string' && typeof task.title === 'string' && !Number.isNaN(Date.parse(task.created));
    return usable ? task : undefined;
  } catch {
    return undefined;
  }
}

/** Every initiative's tasks; a file that does not parse is counted, not fatal. */
export async function loadRoot(root) {
  const bySlug = new Map();
  let unreadable = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name, 'tasks');
    const names = await fs.readdir(dir).catch(() => []);
    const files = names.filter((name) => name.endsWith('.yml'));
    const tasks = await Promise.all(files.map((name) => readTask(path.join(dir, name))));
    const read = tasks.filter((task) => task !== undefined);
    unreadable += tasks.length - read.length;
    if (read.length > 0) bySlug.set(entry.name, read);
  }
  return { bySlug, unreadable };
}

const cell = (text) => String(text).replaceAll('|', '\\|').replace(/\s+/g, ' ');

function renderBand({ band, pairs_in_band, sampled }) {
  const rows = sampled.map(
    (p) => `| ${p.score} | ${p.id} | ${cell(p.title)} | ${p.earlier_id} | ${cell(p.earlier_title)} |`,
  );
  return [
    `### Band ${band} (${sampled.length} of ${pairs_in_band} pairs)`,
    '',
    '| Score | New | New title | Earlier | Earlier title |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ];
}

export function renderReport(result) {
  const refused = Object.entries(result.refused).map(([reason, n]) => `- ${reason}: ${n}`);
  const total = Object.values(result.refused).reduce((sum, n) => sum + n, 0);
  return [
    `Window: ${result.since} to ${result.until}. Tasks created: ${result.tasks_in_window}. Unreadable files skipped: ${result.unreadable}.`,
    '',
    `## Refused by doneWhenProblem: ${total}`,
    '',
    ...refused,
    '',
    '## Flagged per threshold',
    '',
    '| Threshold | Tasks flagged | % of window | Pairs at or above |',
    '|---|---|---|---|',
    ...result.bands.map(
      (b) => `| ${b.threshold.toFixed(1)} | ${b.flagged_tasks} | ${b.flagged_pct} | ${b.pairs_at_or_above} |`,
    ),
    '',
    '## Sampled pairs',
    '',
    ...result.bands.flatMap(renderBand),
  ].join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: process.env.ACTIVE_ROOT },
      days: { type: 'string', default: '14' },
      sample: { type: 'string', default: '20' },
      now: { type: 'string' },
    },
  });
  if (!values.root) throw new Error('--root (or $ACTIVE_ROOT) is required');
  const now = values.now === undefined ? Date.now() : Date.parse(values.now);
  const { bySlug, unreadable } = await loadRoot(values.root);
  const result = replay(bySlug, { now, days: Number(values.days), sample: Number(values.sample) });
  process.stdout.write(`${renderReport({ ...result, unreadable })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
