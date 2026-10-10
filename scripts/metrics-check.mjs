#!/usr/bin/env node
// `pnpm metrics:check`: validates every metrics/<area>.yml against titan.metrics/v1 from
// @titan-design/health/metrics and its area against scripts/areas.mjs. Exits 1 naming file and field.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { loadAreas } from "./areas.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REGISTRY = "metrics";
const ENTRY_FILE = /\.yml$/;

// Imported from the built package so the schema lives only in health; the root does not depend on it.
const SCHEMA_ENTRY = join(ROOT, "packages", "health", "dist", "metrics", "index.js");
const loadSchema = () => import(pathToFileURL(SCHEMA_ENTRY).href);

const registryFiles = (root) => (existsSync(join(root, REGISTRY)) ? readdirSync(join(root, REGISTRY)).sort() : []);
const entryFiles = (root) => registryFiles(root).filter((name) => ENTRY_FILE.test(name));
const strayFiles = (root) => registryFiles(root).filter((name) => !ENTRY_FILE.test(name) && name !== "README.md");

// A metric no query can measure yet must say which slice closes that gap, so the registry never reads as complete.
const unqueriedErrors = (metrics) =>
  metrics.flatMap((metric, index) =>
    metric.query || metric.source?.gapSlice
      ? []
      : [`metrics.${index} (${metric.id}): no query; set source.gapSlice to the slice that adds one, or to \`unfiled\``],
  );

function entryErrors(text, name, areaIds, { METRICS_SCHEMA_ID, validateEntry }) {
  let entry;
  try {
    entry = parse(text);
  } catch (error) {
    return [`(root): not valid YAML: ${error.message}`];
  }
  if (entry?.schema !== METRICS_SCHEMA_ID) return [`schema: expected ${METRICS_SCHEMA_ID}`];
  const result = validateEntry(entry, "write");
  const errors = result.ok ? unqueriedErrors(entry.metrics) : [...result.errors];
  if (typeof entry.area !== "string") return errors;
  if (!areaIds.has(entry.area)) errors.push(`area: \`${entry.area}\` is not an area in scripts/areas.mjs`);
  else if (name.replace(ENTRY_FILE, "") !== entry.area) errors.push(`area: \`${entry.area}\` must match the file name`);
  return errors;
}

/** One message per problem, each starting with the entry's path and the failing field. */
export async function checkMetrics(root, areas) {
  const schema = await loadSchema();
  const areaIds = new Set(areas.map((area) => area.id));
  const stray = strayFiles(root).map((name) => `\`${REGISTRY}/${name}\` (file): entries are named <area>.yml`);
  const invalid = entryFiles(root).flatMap((name) => {
    const text = readFileSync(join(root, REGISTRY, name), "utf8");
    return entryErrors(text, name, areaIds, schema).map((error) => `\`${REGISTRY}/${name}\` ${error}`);
  });
  return [...stray, ...invalid];
}

/** Product areas with no registry entry; a structure test warns on these until W8 seeds them. */
export function metricsCoverageGaps(root, areas) {
  return areas
    .filter((area) => area.tier === "product" && !existsSync(join(root, REGISTRY, `${area.id}.yml`)))
    .map(
      ({ id }) =>
        `Product area \`${id}\` has no \`${REGISTRY}/${id}.yml\`. Run a measurement audit and add its titan.metrics/v1 entry.`,
    );
}

async function main() {
  if (!existsSync(SCHEMA_ENTRY)) {
    console.error(`${SCHEMA_ENTRY} not found; run pnpm build first`);
    process.exitCode = 2;
    return;
  }
  const errors = await checkMetrics(ROOT, loadAreas(ROOT));
  errors.forEach((error) => console.error(error));
  if (errors.length > 0) process.exitCode = 1;
  else console.log(`metrics:check: ${entryFiles(ROOT).length} entries valid`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
