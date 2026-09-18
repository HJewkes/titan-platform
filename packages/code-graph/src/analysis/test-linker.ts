import { couplingFor, type CoEditPair } from "../history/index.js";
import type { GraphMetric, GraphNode } from "../types.js";

/** How a test↔source pairing was inferred. */
export type LinkMethod = "path" | "coedit";

export interface TestSourceLink {
  /** Node id of the test file. */
  testId: string;
  /** Node id of the (non-test) file it covers. */
  sourceId: string;
  method: LinkMethod;
}

export interface LinkTestsOptions {
  /** Minimum co-edit count for a pass-2 (coedit) link. Default 2. */
  minCoEditCount?: number;
}

const DEFAULT_MIN_CO_EDIT_COUNT = 2;
const TEST_INFIX_RE = /\.(?:test|spec)(\.[^./]+)$/;
const TESTS_DIR_RE = /(^|\/)(?:__tests__|tests?)\//;

/**
 * Candidate source paths for a test file, by convention. Strips a
 * `.test`/`.spec` infix (co-located case) and collapses a `__tests__/` or
 * `test(s)/` directory segment (sub-directory case). Returns paths distinct
 * from the test id itself.
 */
function pathCandidates(testId: string): string[] {
  const out = new Set<string>();
  const deInfixed = testId.replace(TEST_INFIX_RE, "$1");
  if (deInfixed !== testId) out.add(deInfixed);
  const deDir = deInfixed.replace(TESTS_DIR_RE, "$1");
  if (deDir !== testId) out.add(deDir);
  return [...out];
}

function splitFileIds(nodes: readonly GraphNode[]): { testIds: string[]; nonTestIds: Set<string> } {
  const testIds: string[] = [];
  const nonTestIds = new Set<string>();
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    if (n.role === "test") testIds.push(n.id);
    else nonTestIds.add(n.id);
  }
  return { testIds, nonTestIds };
}

/**
 * Two-pass test↔source linker. Pass 1 pairs each test file with non-test files
 * matching its path conventions (high confidence). Pass 2 supplements tests
 * left unpaired by pass 1 with their strongest co-edited non-test partner from
 * change-coupling. Handles orphan tests (no pairing), orphan/untested sources
 * (no incoming link), and one-to-many pairings (a test matching several
 * sources, or a source covered by several tests).
 */
export function linkTestsToSources(
  nodes: readonly GraphNode[],
  coEditPairs: readonly CoEditPair[],
  options: LinkTestsOptions = {},
): TestSourceLink[] {
  const minCount = options.minCoEditCount ?? DEFAULT_MIN_CO_EDIT_COUNT;
  const { testIds, nonTestIds } = splitFileIds(nodes);
  const links: TestSourceLink[] = [];
  for (const testId of testIds) {
    const matched = pathCandidates(testId).filter((c) => nonTestIds.has(c));
    if (matched.length > 0) {
      for (const sourceId of matched) {
        links.push({ testId, sourceId, method: "path" });
      }
      continue;
    }
    const partner = couplingFor(coEditPairs, testId).find((p) => p.count >= minCount && nonTestIds.has(p.partner));
    if (partner) {
      links.push({ testId, sourceId: partner.partner, method: "coedit" });
    }
  }
  return links;
}

/**
 * Per-source coverage breadth: how many distinct test files link to each
 * covered source. Emitted only for sources with at least one linked test.
 */
export function testCoverageCountMetrics(links: readonly TestSourceLink[]): GraphMetric[] {
  const testsBySource = groupTestsBySource(links);
  const out: GraphMetric[] = [];
  for (const [sourceId, tests] of testsBySource) {
    out.push({
      nodeId: sourceId,
      name: "linked_test_count",
      value: tests.size,
      unit: "count",
    });
  }
  return out;
}

/** Map each covered source to the set of test files that link to it. */
export function groupTestsBySource(links: readonly TestSourceLink[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const l of links) {
    let set = out.get(l.sourceId);
    if (!set) {
      set = new Set();
      out.set(l.sourceId, set);
    }
    set.add(l.testId);
  }
  return out;
}
