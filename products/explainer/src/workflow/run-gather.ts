import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execGh, type GhExec } from "@titan-design/github";
import { claudeTranscriptRoots } from "@titan-design/session-read";
import { z } from "zod";
import { lanesFileFor, loadLanes } from "../lanes-schema.js";
import { gatherArticle, writeArticleGather } from "../presets/article/gather-article.js";
import { activeWorkTasks } from "../presets/daily/active-work-tasks.js";
import { gatherDaily, writeDailyGather } from "../presets/daily/gather-daily.js";
import type { SnapshotTask } from "../presets/daily/task-snapshot.js";
import type { CallEdgeReader } from "../presets/pr-overview/call-edges.js";
import { gatherPr, writeGather } from "../presets/pr-overview/gather.js";
import { parsePrRef, type GhRun } from "../presets/pr-overview/pr-read.js";
import { briefDir } from "../presets/pr-overview/trigger.js";
import { loadProfiles, profileFor } from "../profile-load.js";
import { sha256 } from "./artifacts.js";

/** The adapters `explainer run --facts-from` takes; a PR brief starts from the visual-gate trigger instead. */
export const CLI_FACT_ADAPTERS = ["gatherDaily", "gatherArticle"] as const;

/**
 * What the gather stage gathers: the adapter and everything it reads, so the request is the stage's cache key. The
 * article and claims are keyed by content, and the PR by the head the gate named.
 */
export const GatherRequestSchema = z.discriminatedUnion("adapter", [
  z.object({ adapter: z.literal("gatherDaily"), type: z.string(), day: z.string(), repos: z.array(z.string()), transcripts: z.array(z.string()), initiative: z.string() }),
  z.object({ adapter: z.literal("gatherPr"), type: z.string(), pr: z.string(), head: z.string(), clone: z.string() }),
  z.object({ adapter: z.literal("gatherArticle"), type: z.string(), day: z.string(), article: z.string(), articleSha: z.string(), claims: z.string(), claimsSha: z.string(), label: z.string() }),
]);
export type GatherRequest = z.infer<typeof GatherRequestSchema>;

/** Reads one file of a commit from a clone; a test passes a fake. */
export type ReadAt = (clone: string, head: string, file: string) => Promise<string>;

const execFileAsync = promisify(execFile);
const gitShow: ReadAt = async (clone, head, file) => (await execFileAsync("git", ["-C", clone, "show", `${head}:${file}`], { maxBuffer: 64 * 1024 * 1024 })).stdout;

/** The adapters' outside world, injectable so a test runs on fake gh, fixture transcripts, a frozen task list and a fake clone. */
export interface GatherDeps {
  gh?: GhExec;
  listTasks?: (initiative: string) => Promise<SnapshotTask[]>;
  prGh?: GhRun;
  callEdges?: CallEdgeReader;
  readAt?: ReadAt;
  /** The daily lanes rule file; the data dir's `daily/lanes.yaml` when it keeps one, else the doctrine default. */
  lanesFile?: string;
}

interface Gathered {
  type: string;
  /** The facts file written into the gather directory, and its text, which the next stage reads as `facts`. */
  facts: string;
  factsText: string;
  items: number;
  notes: string[];
  /** Where the gather kept what it read beyond the facts, when it keeps more. */
  record?: string;
  /** `{ files }` at the gathered head, for a gather that reads a repo: resolve checks code citations against it. */
  code?: string;
}

async function gatherDailyFacts(request: Extract<GatherRequest, { adapter: "gatherDaily" }>, dataDir: string, deps: GatherDeps): Promise<Gathered> {
  const transcriptRoots = request.transcripts.length > 0 ? request.transcripts : claudeTranscriptRoots().map((root) => root.root);
  const lanes = loadLanes(deps.lanesFile ?? lanesFileFor(dataDir));
  const { digest, notes, coverage } = await gatherDaily({
    day: request.day, repos: request.repos, transcriptRoots, initiative: request.initiative,
    snapshotDir: path.join(dataDir, "task-snapshots"), gh: deps.gh ?? execGh, listTasks: deps.listTasks ?? activeWorkTasks, lanes,
  });
  const files = await writeDailyGather(path.join(dataDir, "gather", request.type, request.day), digest, coverage);
  return { type: request.type, facts: files.facts, factsText: readFileSync(files.facts, "utf8"), items: digest.items.length, notes, record: files.digest };
}

function readChecked(file: string, sha: string): string {
  const text = readFileSync(file, "utf8");
  if (sha256(text) !== sha) throw new Error(`${file} changed after the run was planned; start the run again`);
  return text;
}

async function gatherArticleFacts(request: Extract<GatherRequest, { adapter: "gatherArticle" }>, dataDir: string): Promise<Gathered> {
  readChecked(request.article, request.articleSha);
  const claims = z.array(z.unknown()).parse(JSON.parse(readChecked(request.claims, request.claimsSha)));
  const result = await gatherArticle({ articlePath: request.article, label: request.label, claims });
  const files = await writeArticleGather(path.join(dataDir, "gather", request.type, request.day), result);
  const notes = [...result.rejected.map((r) => `rejected claim: ${r.reason}`), ...result.notes.map((n) => `${n.code} ${n.message}`)];
  return { type: request.type, facts: files.facts, factsText: readFileSync(files.facts, "utf8"), items: result.facts.length, notes, record: files.rejected };
}

async function codeAt(clone: string, head: string, paths: readonly string[], readAt: ReadAt): Promise<string> {
  const files = Object.fromEntries(await Promise.all(paths.map(async (file) => [file, await readAt(clone, head, file)] as const)));
  return JSON.stringify({ files });
}

/** Refuses a PR whose head moved off the one the gate named: the brief would explain a commit nobody signs off. */
async function gatherPrFacts(request: Extract<GatherRequest, { adapter: "gatherPr" }>, dataDir: string, deps: GatherDeps): Promise<Gathered> {
  const ref = parsePrRef(request.pr);
  if (!ref) throw new Error(`"${request.pr}" is not owner/repo#N`);
  const dir = briefDir(dataDir, { ...ref, head: request.head });
  const result = await gatherPr({ pr: request.pr, clonePath: request.clone, ...(deps.prGh ? { gh: deps.prGh } : {}), ...(deps.callEdges ? { callEdges: deps.callEdges } : {}) });
  await writeGather(dir, result);
  if (!result.ok) throw new Error(`gatherPr refused ${request.pr}: ${result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).join(", ")}; see ${path.join(dir, "gather.json")}`);
  if (result.head !== request.head) throw new Error(`${request.pr} head moved to ${result.head} after the gate named ${request.head}`);
  const changed = result.facts.flatMap((fact) => (fact.kind === "change" && fact.status !== "deleted" && fact.path ? [fact.path] : []));
  const facts = path.join(dir, "facts.jsonl");
  const code = await codeAt(request.clone, request.head, changed, deps.readAt ?? gitShow);
  const notes = result.diagnostics.map((d) => `${d.code} ${d.message}`);
  return { type: request.type, facts, factsText: readFileSync(facts, "utf8"), items: result.facts.length, notes, record: path.join(dir, "gather.json"), code };
}

/** Checks the type takes facts from the adapter, then runs it into its gather directory under `dataDir`. */
export function gatherFacts(request: GatherRequest, dataDir: string, deps: GatherDeps = {}): Promise<Gathered> {
  const profile = profileFor(loadProfiles(), request.type);
  if (!profile.inputs.adapters.includes(request.adapter)) {
    throw new Error(`type ${request.type} takes facts from ${profile.inputs.adapters.join(", ") || "no adapter"}, not ${request.adapter}`);
  }
  if (request.adapter === "gatherDaily") return gatherDailyFacts(request, dataDir, deps);
  if (request.adapter === "gatherArticle") return gatherArticleFacts(request, dataDir);
  return gatherPrFacts(request, dataDir, deps);
}

export interface GatherFlags {
  factsFrom: (typeof CLI_FACT_ADAPTERS)[number];
  type?: string;
  day?: string;
  repo: string[];
  transcripts: string[];
  initiative: string;
  article?: string;
  claims?: string;
  label?: string;
}

/** A request `explainer run --facts-from` makes: each one names the day its gather directory is for. */
type DayGatherRequest = Extract<GatherRequest, { day: string }>;

function articleRequest(flags: GatherFlags, type: string, day: string): DayGatherRequest {
  if (!flags.article || !flags.claims) throw new Error("--facts-from gatherArticle needs --article <path> and --claims <path>");
  const label = flags.label ?? path.basename(flags.article, path.extname(flags.article));
  const shaOf = (file: string) => sha256(readFileSync(file, "utf8"));
  return { adapter: "gatherArticle", type, day, article: flags.article, articleSha: shaOf(flags.article), claims: flags.claims, claimsSha: shaOf(flags.claims), label };
}

/** The gather request `explainer run --facts-from` makes: what the gather stage, or a gather before the run, reads. */
export function gatherRequest(flags: GatherFlags): DayGatherRequest {
  if (!flags.type) throw new Error(`--facts-from ${flags.factsFrom} needs --type, the video type whose facts it gathers`);
  const day = flags.day ?? new Date().toISOString().slice(0, 10);
  if (flags.factsFrom === "gatherArticle") return articleRequest(flags, flags.type, day);
  return { adapter: "gatherDaily", type: flags.type, day, repos: flags.repo, transcripts: flags.transcripts, initiative: flags.initiative };
}
