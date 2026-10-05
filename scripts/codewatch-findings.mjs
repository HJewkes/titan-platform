#!/usr/bin/env node
// codewatch-findings@1 (C-128): diffs two codewatch-metrics@1 artifacts of one repo and ranks the debt worth filing.
// It never indexes. Like its input it carries repo paths, symbols and metrics only, so it is safe as a public artifact.
// Status is decided per rule hit. The key is `repo|rule|path|symbol#n`, so it survives line moves and commits; its rule
// is the one broken furthest past its threshold, never the status-weighted score, so a key does not flip with status.
// Without a previous artifact, or when the two indexVersions differ, metric values are not comparable: every row is
// `rebaseline` (no bonus), no row is resolved, and the file rule, which needs a new or worsened status, finds nothing.
// `top` is the first 10 eligible keys before dedupe; the filer applies the per-repo, file-rule and dedupe limits.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { METRICS_SCHEMA_ID } from "./codewatch-metrics.mjs";

export const FINDINGS_SCHEMA_ID = "codewatch-findings@1";
export const THRESHOLDS = { cognitive: 25, cyclomatic: 24, nesting: 5, file_loc: 300 };
const SYMBOL_RULES = [
  { id: "cognitive-hotspot", metric: "cognitive_max", threshold: THRESHOLDS.cognitive, est: 1 },
  { id: "cyclomatic-near-budget", metric: "cyclomatic_max", threshold: THRESHOLDS.cyclomatic, est: 1 },
  { id: "nesting-at-budget", metric: "nesting_max", threshold: THRESHOLDS.nesting, est: 1 },
];
const FILE_RULE = { id: "file-near-loc-budget", metric: "loc", threshold: THRESHOLDS.file_loc, est: 2 };
const STATUS_WEIGHT = { new: 1.5, worsened: 1.3, persisting: 1, rebaseline: 1 };
const WORSENED_RATIO = 1.1;
const REACH_CAP = 20;
const TOP_SIZE = 10;
const METRIC_COLUMNS = ["loc", "cyclomatic_max", "cognitive_max", "nesting_max"];

/** Pure: ranks `current` against `previous` (or null). `sha256` records the content hashes the caller read. */
export function rankFindings(current, previous, { repo = "", sha256 = {} } = {}) {
  const rebaseline = previous === null || previous.indexVersion !== current.indexVersion;
  const now = sourceEntities(current);
  const before = rebaseline ? new Map() : sourceEntities(previous);
  const live = [...now.values()].map((e) => liveFinding(repo, e, before.get(e.id), rebaseline));
  const gone = [...before.values()].map((e) => resolvedFinding(repo, e, now.get(e.id)));
  const findings = [...live, ...gone].filter(Boolean).sort(byRank);
  return {
    schema: FINDINGS_SCHEMA_ID,
    repo,
    current: artifactRef(current, sha256.current),
    previous: previous === null ? null : artifactRef(previous, sha256.previous),
    rebaseline,
    thresholds: { ...THRESHOLDS },
    findings,
    top: selectTop(findings),
  };
}

function artifactRef(artifact, sha256) {
  return { commit: artifact.commit ?? null, indexVersion: artifact.indexVersion ?? null, sha256: sha256 ?? null };
}

// Rows of role=source files only, keyed `path|` for the file and `path|symbol#n` for symbols, n in line order.
function sourceEntities(artifact) {
  const roles = new Map(artifact.files.map((f) => [f.path, f.role]));
  const out = new Map();
  for (const row of artifact.files) {
    if (row.role === "source") out.set(`${row.path}|`, { id: `${row.path}|`, kind: "file", path: row.path, symbol: null, row });
  }
  const seen = new Map();
  for (const row of [...artifact.symbols].sort(byLine)) {
    if (roles.get(row.path) !== "source") continue;
    const name = `${row.path}|${row.symbol}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    out.set(`${name}#${n}`, { id: `${name}#${n}`, kind: "symbol", path: row.path, symbol: row.symbol, row });
  }
  return out;
}

function byLine(a, b) {
  return compare(a.path, b.path) || compare(a.symbol, b.symbol) || (a.line ?? Infinity) - (b.line ?? Infinity);
}

// A null metric means the row has nothing to measure (cyclomatic_max on a file with no function), never zero.
const isHit = (value, threshold) => typeof value === "number" && value >= threshold;

function ruleHits(entity) {
  const rules = entity.kind === "file" ? [FILE_RULE] : SYMBOL_RULES;
  return rules.filter((rule) => isHit(entity.row[rule.metric], rule.threshold));
}

function hitStatus(rule, entity, was, rebaseline) {
  if (rebaseline) return "rebaseline";
  const before = was?.row[rule.metric];
  if (!isHit(before, rule.threshold)) return "new";
  return entity.row[rule.metric] >= before * WORSENED_RATIO ? "worsened" : "persisting";
}

function score(value, rule, status, importers) {
  const reach = 1 + Math.min(importers ?? 0, REACH_CAP) / REACH_CAP;
  return Math.round((value / rule.threshold) * STATUS_WEIGHT[status] * reach * 1000) / 1000;
}

// Status-independent, so live and resolved rows of one entity share a key; ties keep rule order.
function keyRule(rules, row) {
  const ratio = (rule) => row[rule.metric] / rule.threshold;
  return rules.reduce((best, rule) => (ratio(rule) > ratio(best) ? rule : best));
}

// One row per entity, scored and given the status of its highest-scoring hit.
function liveFinding(repo, entity, was, rebaseline) {
  const hits = ruleHits(entity)
    .map((rule) => ({ rule, status: hitStatus(rule, entity, was, rebaseline) }))
    .filter(({ rule, status }) => rule !== FILE_RULE || status === "new" || status === "worsened")
    .map((hit) => ({ ...hit, score: score(entity.row[hit.rule.metric], hit.rule, hit.status, entity.row.importers) }));
  if (hits.length === 0) return null;
  const lead = hits.reduce((best, hit) => (hit.score > best.score ? hit : best));
  const rules = hits.map((h) => h.rule);
  const rule = keyRule(rules, entity.row);
  return finding(repo, entity, { ...lead, rule, rules, current: entity.row, previous: was?.row });
}

// Every rule the entity broke last time is now clear; its key is the one its last live row carried.
function resolvedFinding(repo, was, now) {
  const rules = ruleHits(was);
  if (rules.length === 0 || (now && ruleHits(now).length > 0)) return null;
  const rule = keyRule(rules, was.row);
  return finding(repo, now ?? was, { rule, rules, status: "resolved", score: 0, current: now?.row, previous: was.row });
}

function finding(repo, entity, { rule, rules, status, score: value, current, previous }) {
  return {
    key: `${repo}|${rule.id}|${entity.id}`,
    rules: rules.map((r) => r.id),
    path: entity.path,
    symbol: entity.symbol,
    line: entity.row.line ?? null,
    exported: entity.row.exported ?? null,
    metrics: metricsOf(current),
    previous_metrics: previous ? metricsOf(previous) : null,
    importers: entity.row.importers ?? 0,
    status,
    score: value,
    est: rule.est,
  };
}

function metricsOf(row) {
  return Object.fromEntries(METRIC_COLUMNS.map((column) => [column, row?.[column] ?? null]));
}

function byRank(a, b) {
  return b.score - a.score || compare(a.path, b.path) || compare(a.symbol ?? "", b.symbol ?? "") || compare(a.key, b.key);
}

function selectTop(findings) {
  return findings.filter((f) => f.score >= 1).slice(0, TOP_SIZE).map((f) => f.key);
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const USAGE =
  "usage: codewatch-findings.mjs --repo <name> --current <file> [--previous <file> --previous-sha256 <hex>] --out <file>";

/** Writes the findings JSON to --out. Returns the exit code: 2 on bad arguments, an unreadable input or a pin mismatch. */
export function runCli(argv) {
  const args = Object.fromEntries(["repo", "current", "previous", "previous-sha256", "out"].map((n) => [n, flag(argv, `--${n}`)]));
  if (!args.repo || args.repo.includes("|") || !args.current || !args.out || !args.previous !== !args["previous-sha256"]) {
    console.error(USAGE);
    return 2;
  }
  try {
    const current = readArtifact(args.current);
    const previous = args.previous ? readArtifact(args.previous, args["previous-sha256"]) : null;
    const sha256 = { current: current.sha256, previous: previous?.sha256 };
    const report = rankFindings(current.json, previous?.json ?? null, { repo: args.repo, sha256 });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    const mode = report.rebaseline ? ", rebaseline" : "";
    console.error(`codewatch-findings: ${report.findings.length} findings, ${report.top.length} in top${mode}`);
    return 0;
  } catch (err) {
    console.error(`codewatch-findings: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

function readArtifact(file, pinnedSha256) {
  const bytes = readFileSync(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (pinnedSha256 && sha256 !== pinnedSha256.toLowerCase()) {
    throw new Error(`${file} has sha256 ${sha256}, but --previous-sha256 pins ${pinnedSha256}: refusing to diff against another baseline`);
  }
  const json = JSON.parse(bytes.toString("utf8"));
  if (json?.schema !== METRICS_SCHEMA_ID) throw new Error(`${file} is not ${METRICS_SCHEMA_ID} (schema: ${json?.schema})`);
  return { json, sha256 };
}

// A missing value, or another flag in its place, reads as absent so the usage check catches it.
function flag(argv, name) {
  const value = argv[argv.indexOf(name) + 1];
  return argv.includes(name) && value && !value.startsWith("--") ? value : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
