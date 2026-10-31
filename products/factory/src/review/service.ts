import { dirname, join } from "node:path";
import { githubPort, octokitWire, sharedOctokit, type GitHubPort } from "@titan-design/github";
import { gateMigration, gateResolverMigration, SqliteGateStore } from "@titan-design/hitl/sqlite";
import type { ReviewTarget } from "@titan-design/review-panel";
import { reviewRunner, type Resumed, type ReviewRunner } from "@titan-design/review-workflow";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { workflowMigration, workflowOwnershipMigration } from "@titan-design/workflow";
import { configPath, loadConfig, type ReviewConfig } from "../config.js";
import { classRulesFor, panelPolicyFor } from "../shepherd/review-panel-plan.js";
import { reviewCheckoutRoot } from "../shepherd/review-checkout.js";
import { configuredRoles } from "../shepherd/reviewer-roles.js";
import { membersOf, type CiRead, type ReviewReport } from "./format.js";
import { reviewParkingMigration, sqliteParking } from "./parking.js";
import { reviewPorts, type ReviewPortsConfig } from "./ports.js";
import { headOf, type PrTarget } from "./pr-facts.js";

/** What the `review` verbs run against; tests pass a fake, the bin opens the configured one. */
export interface ReviewService {
  /** The PR's head: `head` checked when given, else read live from GitHub. */
  headOf(target: PrTarget, head?: string): Promise<string>;
  review(target: ReviewTarget): Promise<ReviewReport>;
  resolve(fingerprint: string): Promise<Resumed[]>;
  close(): void;
}

/** Beside the factory database, never in it: serve hydrates that one's runs, and a review run is the CLI's own. */
const REVIEW_DB = "review.sqlite3";

function openReviewDb(path: string): Db {
  const db = openDatabase(path);
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4), reviewParkingMigration(5)]);
  return db;
}

function configuredShepherd(env: NodeJS.ProcessEnv): ReviewPortsConfig["shepherd"] {
  const shepherd = loadConfig(configPath(env)).shepherd;
  if (!shepherd?.review || !shepherd.agentChatBin) throw new Error("review needs shepherd.review and shepherd.agentChatBin in the factory config");
  return { ...shepherd, review: shepherd.review, agentChatBin: shepherd.agentChatBin };
}

function timingOf({ sessionStartTimeoutMs, verdictTimeoutMs }: ReviewConfig) {
  return { ...(sessionStartTimeoutMs !== undefined && { startDeadlineMs: sessionStartTimeoutMs }), ...(verdictTimeoutMs !== undefined && { verdictDeadlineMs: verdictTimeoutMs }) };
}

type CiReads = Map<string, CiRead>;
const ciKey = ({ repo, pr, head }: ReviewTarget): string => `${repo}#${pr}@${head}`;

/** The workflow's request: the brief carries only the checkout root, since no Shepherd run holds a kind, a proof or earlier findings. */
function serviceOver(runner: ReviewRunner, port: Pick<GitHubPort, "getPr">, checkoutRoot: string, ciReads: CiReads, close: () => void): ReviewService {
  return {
    headOf: (target, head) => headOf(port, target, head),
    review: async (target) => {
      const runId = runner.start({ target, brief: { checkoutRoot } });
      const outcome = await runner.outcome(runId);
      const ci = ciReads.get(ciKey(target));
      return { runId, outcome, members: membersOf(runner.runtime.status(runId) ?? { stepResults: {} }), ...(ci !== undefined && { ci }) };
    },
    resolve: (fingerprint) => runner.resolve(fingerprint),
    close,
  };
}

/** The review runner over the factory config, its runs and parked fingerprints kept in `review.sqlite3` beside `factoryDb`. */
export function configuredReviewService(env: NodeJS.ProcessEnv, factoryDb: string): ReviewService {
  const shepherd = configuredShepherd(env);
  const db = openReviewDb(join(dirname(factoryDb), REVIEW_DB));
  const port = githubPort(octokitWire({ client: sharedOctokit() }));
  const checkoutRoot = reviewCheckoutRoot();
  const roles = configuredRoles(shepherd.review);
  const ciReads: CiReads = new Map();
  const onCi = (target: ReviewTarget, ci: CiRead) => void ciReads.set(ciKey(target), ci);
  const ports = reviewPorts({ shepherd, checkoutRoot, parking: sqliteParking(db), port, onCi });
  const policy = { plan: { panel: panelPolicyFor(roles), rules: classRulesFor(roles) }, timing: timingOf(shepherd.review) };
  const runner = reviewRunner({ ports, policy, runtime: { db, gates: new SqliteGateStore(db, { migrate: false }) } });
  return serviceOver(runner, port, checkoutRoot, ciReads, () => {
    runner.runtime.shutdown();
    db.close();
  });
}
