import { compileGlobs } from "@titan-design/fix-proof";
import { resolveConfig, type BurdenConfig, type ChangedFile, type PackageJsonChange } from "./config.js";
import { hasContract, parseFooter } from "./footer.js";
import { addedDependencies, surfaceChanged } from "./package-json.js";
import { pathClassifier } from "./path-class.js";

export const MAX_BURDEN = 100;

export interface BurdenInput {
  files: readonly ChangedFile[];
  /** `.codewatch/check.json` `$tiers`: tier name to unit directories; absent in a repo with no tier map. */
  tiers?: Readonly<Record<string, readonly string[]>>;
  packageJsons?: readonly PackageJsonChange[];
  body: string;
  config?: Partial<BurdenConfig>;
}

/** The derived inputs each part reads, so a reader can see why a part scored what it did. */
export interface BurdenFacts {
  productionLines: number;
  testLines: number;
  productionFiles: number;
  units: string[];
  /** The lowest numeric tier a production file touched; absent when none is mapped. */
  tier?: number;
  api: boolean;
  migration: boolean;
  runtimeDeps: number;
  devDeps: number;
  footer: boolean;
  contract: boolean;
}

export interface BurdenParts {
  size: number;
  spread: number;
  tests: number;
  tier: number;
  api: number;
  migration: number;
  deps: number;
  rationale: number;
  contract: number;
}

export interface BurdenScore {
  total: number;
  parts: BurdenParts;
  facts: BurdenFacts;
}

/** The 0 to 100 review burden: each part from its own row, summed and capped. Same input, same score. */
export function burdenScore(input: BurdenInput): BurdenScore {
  const facts = burdenFacts(input);
  const parts = scoreParts(facts);
  const sum = Object.values(parts).reduce((total, points) => total + points, 0);
  return { total: Math.min(MAX_BURDEN, sum), parts, facts };
}

export function burdenFacts(input: BurdenInput): BurdenFacts {
  const config = resolveConfig(input.config);
  const classify = pathClassifier(config);
  const production = input.files.filter((file) => classify(file.path) === "production");
  const tests = input.files.filter((file) => classify(file.path) === "test");
  const footer = parseFooter(input.body);
  const facts: BurdenFacts = {
    productionLines: linesOf(production),
    testLines: linesOf(tests),
    productionFiles: production.length,
    units: [...new Set(production.flatMap(unitOf))].sort(),
    ...surfaceFacts(input, config),
    footer: footer.present,
    contract: hasContract(footer),
  };
  const tier = lowestTier(production, input.tiers);
  if (tier !== undefined) facts.tier = tier;
  return facts;
}

function surfaceFacts(input: BurdenInput, config: BurdenConfig): Pick<BurdenFacts, "api" | "migration" | "runtimeDeps" | "devDeps"> {
  const paths = input.files.map((file) => file.path);
  const packageJsons = input.packageJsons ?? [];
  const added = (section: "dependencies" | "devDependencies") =>
    packageJsons.reduce((count, change) => count + addedDependencies(change, section).length, 0);
  return {
    api: paths.some(compileGlobs(config.apiGlobs)) || packageJsons.some(surfaceChanged),
    migration: paths.some(compileGlobs(config.migrationGlobs)),
    runtimeDeps: added("dependencies"),
    devDeps: added("devDependencies"),
  };
}

export function scoreParts(facts: BurdenFacts): BurdenParts {
  const files = facts.productionFiles;
  const units = facts.units.length;
  return {
    size: Math.min(30, Math.round(10 * Math.log2(1 + facts.productionLines / 50))),
    spread: Math.min(10, Math.max(0, files - 1)) + Math.min(10, 5 * Math.max(0, units - 1)),
    tests: testPoints(facts.productionLines, facts.testLines),
    tier: TIER_POINTS[facts.tier ?? -1] ?? 0,
    api: facts.api ? 10 : 0,
    migration: facts.migration ? 15 : 0,
    deps: Math.min(10, 5 * facts.runtimeDeps + 2 * facts.devDeps),
    rationale: facts.footer ? 0 : 10,
    contract: facts.contract ? 0 : 5,
  };
}

const TIER_POINTS: Record<number, number> = { 0: 10, 1: 6, 2: 3 };

function testPoints(production: number, test: number): number {
  if (production <= 10) return 0;
  if (test === 0) return 15;
  const ratio = test / production;
  return ratio < 0.2 ? 10 : ratio < 0.5 ? 5 : 0;
}

function linesOf(files: readonly ChangedFile[]): number {
  return files.reduce((total, file) => total + file.additions + file.deletions, 0);
}

/**
 * The unit a path belongs to: `packages/x`, `products/x` or `apps/x`, then `src/<dir>` for a
 * single-package repo, else the top-level directory. A root file is repo-wide config and joins no unit.
 */
export function unitOf(file: ChangedFile): string[] {
  const parts = file.path.split("/");
  if (parts.length < 2) return [];
  const [top = "", second = ""] = parts;
  if (parts.length > 2 && (["packages", "products", "apps"].includes(top) || top === "src")) return [`${top}/${second}`];
  return [top];
}

// Non-numeric tiers such as `ui` or `product` sit above every numbered one.
function lowestTier(production: readonly ChangedFile[], tiers: BurdenInput["tiers"]): number | undefined {
  if (!tiers) return undefined;
  const touches = (dir: string) => production.some((file) => file.path.startsWith(`${dir}/`));
  const numbered = Object.entries(tiers)
    .filter(([name, dirs]) => /^\d+$/.test(name) && dirs.some(touches))
    .map(([name]) => Number(name));
  return numbered.length > 0 ? Math.min(...numbered) : undefined;
}
