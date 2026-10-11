import { randomBytes } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { dispatchToAgentChat, listAgents } from "../packages/agent-dispatch/dist/index.js";
import { appDirs } from "../packages/app-paths/dist/index.js";
import { reviewerBrief } from "../packages/review-panel/dist/index.js";
// Shepherd's own host check and rule text, loaded through Node's type stripping (the factory package does not export them),
// so the smoke brief tells the reviewer to run exactly the commands a Shepherd reviewer on this host runs.
import { localBasementSuite, suiteRules } from "../products/factory/src/shepherd/suite-host.ts";
import { checkReviewerTranscript } from "./reviewer-smoke-check.mjs";

// The two profiles Shepherd spawns (DEFAULT_CLASS_ROLES): bd-reviewer for g10, reviewer otherwise.
const PROFILES = ["reviewer", "bd-reviewer"];
const POLL_MS = 15_000;
const SPAWN_TIMEOUT_MS = 60_000;
// `agent ls --json` takes about 6.5 s on the Mac.
const ROSTER_TIMEOUT_MS = 30_000;

const USAGE = "usage: pnpm smoke:reviewer --repo <owner/name> --pr <n> --head <40-hex sha> --profile <reviewer|bd-reviewer> [--cwd <repo checkout, required with --run>] [--timeout-min 20] [--agent-chat <path>] [--run]";

function options() {
  const { values } = parseArgs({ options: {
    repo: { type: "string" }, pr: { type: "string" }, head: { type: "string" }, profile: { type: "string", default: "reviewer" },
    cwd: { type: "string" }, "timeout-min": { type: "string", default: "20" }, "agent-chat": { type: "string" }, run: { type: "boolean", default: false },
  } });
  const pr = Number(values.pr);
  const valid = /^[\w.-]+\/[\w.-]+$/.test(values.repo ?? "") && Number.isSafeInteger(pr) && pr > 0 && /^[0-9a-f]{40}$/.test(values.head ?? "") && PROFILES.includes(values.profile) && (!values.run || values.cwd !== undefined);
  if (!valid) throw new Error(USAGE);
  return { ...values, pr, timeoutMs: Number(values["timeout-min"]) * 60_000, agentChat: values["agent-chat"] ?? onPath("agent-chat") };
}

function onPath(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Same root Shepherd hands its reviewers (`reviewCheckoutRoot` in products/factory). */
function checkoutRoot() {
  return path.join(appDirs("titan-factory").data, "checkouts", "reviews");
}

function plan(opts) {
  const name = `rv-smoke-${opts.pr}-${opts.profile}-${randomBytes(2).toString("hex")}`;
  const onBasement = localBasementSuite();
  const testRule = suiteRules(onBasement).reviewer;
  const brief = reviewerBrief({ repo: opts.repo, pr: opts.pr, head: opts.head, checkoutRoot: checkoutRoot(), testRule });
  return { name, profile: opts.profile, host: onBasement ? "basement" : "mac", cwd: opts.cwd ?? null, agentChat: opts.agentChat, timeoutMs: opts.timeoutMs, brief };
}

async function awaitExit(agentChat, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = (await listAgents(agentChat, ROSTER_TIMEOUT_MS)).find((candidate) => candidate.name === name);
    if (row?.presence === "exited" && row.transcriptExists && row.transcriptPath) return row;
    await sleep(POLL_MS);
  }
  throw new Error(`${name} did not exit with a transcript within ${timeoutMs / 60_000} min`);
}

async function run(opts, spawn) {
  if (!spawn.agentChat) throw new Error("agent-chat is not on PATH; pass --agent-chat <absolute path>");
  dispatchToAgentChat({ agentChatBinPath: spawn.agentChat, peerName: spawn.name, profile: spawn.profile, brief: spawn.brief, cwd: spawn.cwd }, SPAWN_TIMEOUT_MS, PROFILES);
  const row = await awaitExit(spawn.agentChat, spawn.name, spawn.timeoutMs);
  const lines = readFileSync(row.transcriptPath, "utf8").split("\n").filter(Boolean);
  const report = checkReviewerTranscript(lines, { repo: opts.repo, pr: opts.pr, head: opts.head });
  return { reviewer: spawn.name, profile: spawn.profile, model: row.model ?? null, sessionId: row.sessionId, transcript: row.transcriptPath, ...report };
}

const opts = options();
const spawn = plan(opts);
// Deliberately opt-in: --run spawns a real reviewer (Sonnet or Opus) billed to the broker's login.
if (!opts.run) {
  console.log(JSON.stringify({ dryRun: true, note: "pass --run to spawn this reviewer", ...spawn }, null, 2));
} else {
  const report = await run(opts, spawn);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
