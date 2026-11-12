import type { MergeFacts } from "@titan-design/authority";
import { compileGlobs } from "@titan-design/fix-proof";
import { z } from "zod";
import { baselineCheckGreen, cannotRender, shownPaths } from "./visual-gate.js";

type VisualTierVerdict = { tier: 1; basis: "non-rendering" } | { tier: 2; reason: string };

interface VisualTierInput {
  /** changedPaths is every touched path, both sides of a rename, never pre-filtered: the classifier sees all of it. */
  merge: Pick<MergeFacts, "head" | "checkRuns" | "changedPaths">;
  /** policy.visualPaths as configured; the classifier does its own visual match. */
  visualPaths: readonly string[];
  mergeBase: string;
  /** Raw shepherd.visualTier[repo]; parsed here. Its mode is applied by the caller, not here. */
  config: unknown;
}

const MAX_GLOBS = 200;
const FULL_SHA = /^[0-9a-f]{40}$/;
const CODE_FILE = /\.(ts|js|mts|cts|mjs|cjs)$/;

const nonBlank = z.string().trim().min(1).max(1024);
const globList = z.array(nonBlank).min(1).max(MAX_GLOBS);

const VisualTierConfigSchema = z.strictObject({
  mode: z.enum(["off", "shadow", "on"]),
  harnessPaths: globList,
  renderingPaths: globList,
  storyPaths: globList,
  logicPaths: globList,
  testArtifactPaths: globList,
  storyDiff: z.strictObject({ check: nonBlank, paths: globList, allowedApps: z.array(z.number().int().positive()).min(1) }),
});

const InputSchema = z.object({
  head: z.string().regex(FULL_SHA),
  mergeBase: z.string().regex(FULL_SHA),
  changedPaths: z.array(z.string().trim().min(1)).min(1),
});

type PathClass = "harness" | "rendering" | "snapshot" | "outside" | "inert" | "test-artifact" | "story" | "logic" | "rendered";
type Row = readonly [PathClass, (path: string) => boolean];

interface TierPolicy {
  rows: readonly Row[];
  storyDiff: { check: string; allowedApps: readonly number[] };
}

const CLEARING: ReadonlySet<PathClass> = new Set(["outside", "inert", "test-artifact", "story", "logic"]);

function caseFolded(globs: readonly string[]): (path: string) => boolean {
  const matches = compileGlobs(globs.map((glob) => glob.toLowerCase()));
  return (path) => matches(path.toLowerCase());
}

/** Gating rows come before `outside` and `inert`, so a gating path is seen wherever it sits and whatever it is named. */
function tierRows(config: z.infer<typeof VisualTierConfigSchema>, visualPaths: readonly string[]): Row[] {
  const visual = caseFolded(visualPaths);
  const logic = caseFolded(config.logicPaths);
  return [
    ["harness", caseFolded(config.harnessPaths)],
    ["rendering", caseFolded(config.renderingPaths)],
    ["snapshot", caseFolded(config.storyDiff.paths)],
    ["outside", (path) => !visual(path)],
    ["inert", cannotRender],
    ["test-artifact", caseFolded(config.testArtifactPaths)],
    ["story", caseFolded([...config.storyPaths, "**/*.stories.*"])],
    ["logic", (path) => CODE_FILE.test(path.toLowerCase()) && logic(path)],
  ];
}

/** A list that fails to parse or compile fails the whole policy, so no list can quietly match nothing. */
function compileTierPolicy(config: unknown, visualPaths: readonly string[]): TierPolicy | string {
  const parsed = VisualTierConfigSchema.safeParse(config);
  if (!parsed.success) return firstIssue(parsed.error);
  const visual = globList.safeParse(visualPaths);
  if (!visual.success) return `visualPaths ${firstIssue(visual.error)}`;
  try {
    return { rows: tierRows(parsed.data, visual.data), storyDiff: parsed.data.storyDiff };
  } catch (error) {
    return error instanceof Error ? error.message : "a glob did not compile";
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? "unreadable" : `${issue.path.join(".") || "(root)"}: ${issue.message}`;
}

function classOf(path: string, policy: TierPolicy): PathClass {
  return policy.rows.find(([, matches]) => matches(path))?.[0] ?? "rendered";
}

const tier2 = (reason: string): VisualTierVerdict => ({ tier: 2, reason });

/**
 * The only place tier 1 is built: every changed path must sit in a class this proof clears. A rendered path is always
 * tier 2, since any pr-visual producer on pull_request runs head-controlled code (TP-4761 C2).
 */
function proveTierOne(classes: readonly (readonly [string, PathClass])[], merge: VisualTierInput["merge"], policy: TierPolicy): VisualTierVerdict {
  const pathsOf = (wanted: PathClass) => classes.filter(([, cls]) => cls === wanted).map(([path]) => path);
  const offending = classes.find(([, cls]) => !CLEARING.has(cls));
  if (offending !== undefined) return tier2(`${offending[1] === "rendered" ? "renders" : offending[1]}: ${shownPaths(pathsOf(offending[1]))}`);
  const { check, allowedApps } = policy.storyDiff;
  if (pathsOf("logic").length > 0 && !baselineCheckGreen(merge, check, allowedApps)) return tier2(`logic with ${check} not green at the head`);
  return { tier: 1, basis: "non-rendering" };
}

export function visualTier(input: VisualTierInput): VisualTierVerdict {
  const policy = compileTierPolicy(input.config, input.visualPaths);
  if (typeof policy === "string") return tier2(`visual tier policy unreadable: ${policy}`);
  const facts = InputSchema.safeParse({ head: input.merge.head, mergeBase: input.mergeBase, changedPaths: input.merge.changedPaths });
  if (!facts.success) return tier2(`visual tier input unreadable: ${firstIssue(facts.error)}`);
  const classes = input.merge.changedPaths.map((path) => [path, classOf(path, policy)] as const);
  return proveTierOne(classes, input.merge, policy);
}
