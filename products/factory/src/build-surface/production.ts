import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgent } from "@titan-design/agent";
import { minimalEnv } from "@titan-design/agent-dispatch";
import type { GitHubPort } from "@titan-design/github";
import type { JsonEnvelope } from "@titan-design/registry";
import { z } from "zod";
import { agentChatImplementerRunner, type ImplementerRunner } from "../agent-chat-implementer.js";
import { agentChatAgents } from "../shepherd/agents.js";
import { activeWorkFixTasks, activeWorkOrigin } from "../shepherd/cleanup-ports.js";
import type { RosterReader } from "../shepherd/roster.js";
import type { SpawnGate } from "../shepherd/spawn-gate.js";
import { postRpc } from "../cli-shepherd-rpc.js";
import { FACTORY_PORT } from "../serve.js";
import { sleep } from "../workflows/deadline.js";
import type { BuildSurfacePorts, CommandRequest, CommandRun, ShepherdPort } from "./ports.js";
import type { LandState } from "./schemas.js";

/** Gate runs can be long; this only stops a command that hangs for good. */
const COMMAND_TIMEOUT_MS = 2 * 60 * 60_000;
const LAND_POLL_MS = 60_000;
const OUTPUT_CAP = 1_000_000;

/** Repo commands are the repo's own scripts in the owner's clone: they get PATH and the build's BS_* names, nothing else. */
function runCommand(argv: readonly string[], request: CommandRequest): Promise<CommandRun> {
  return new Promise((resolve, reject) => {
    const env = { ...minimalEnv(), ...(process.env.PATH && { PATH: process.env.PATH }), ...request.env };
    const child = spawn(argv[0]!, argv.slice(1), { cwd: request.cwd, env, signal: request.signal, timeout: COMMAND_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => void (stdout = (stdout + chunk.toString()).slice(-OUTPUT_CAP)));
    child.stderr.on("data", (chunk: Buffer) => void (stderr = (stderr + chunk.toString()).slice(-OUTPUT_CAP)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    child.stdin.end(request.input ?? "");
  });
}

async function readEvidence(dir: string): Promise<{ path: string; json: unknown }[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(names.map(async (name) => ({ path: join(dir, name), json: JSON.parse(await readFile(join(dir, name), "utf8")) as unknown })));
}

/** Calls serve's own registry over loopback, so a registration made here is the same one `titan-factory shepherd register` makes. */
type RpcCall = <T>(name: string, args: unknown) => Promise<JsonEnvelope<T>>;

/** serve's default port; a serve started on another port is not reached, and the step fails naming the call. */
const loopbackRpc: RpcCall = (name, args) => postRpc(FACTORY_PORT, name, args);

const StatusRows = z.array(z.looseObject({ runId: z.string(), headSha: z.string().nullable(), outcome: z.object({ kind: z.enum(["merged", "stopped"]), reason: z.string().nullable() }).nullable() }));

async function landState(rpc: RpcCall, github: Pick<GitHubPort, "getPr">, request: { repo: string; pr: number; head: string }): Promise<LandState | undefined> {
  const envelope = await rpc<unknown>("shepherd.status", { repo: request.repo, pr: request.pr });
  if (!envelope.ok) throw new Error(`shepherd.status: ${envelope.error}`);
  const row = StatusRows.parse(envelope.data).at(-1);
  if (!row) throw new Error(`Shepherd has no registration for ${request.repo}#${request.pr}`);
  if (row.outcome?.kind === "stopped") return { state: "stopped", reason: row.outcome.reason ?? "stopped" };
  if (row.outcome?.kind === "merged") {
    const merged = await github.getPr(request.repo, request.pr);
    if (merged.mergeSha) return { state: "merged", mergeSha: merged.mergeSha };
  }
  if (row.headSha && row.headSha !== request.head) return { state: "moved", head: row.headSha };
  return undefined;
}

function rpcShepherd(rpc: RpcCall, github: Pick<GitHubPort, "getPr">, pollMs = LAND_POLL_MS): ShepherdPort {
  return {
    async register(request) {
      const envelope = await rpc<{ runId: string }>("shepherd.register", { ...request, kind: "feature" });
      if (!envelope.ok) throw new Error(`shepherd.register: ${envelope.error}`);
      return { runId: envelope.data.runId };
    },
    async land(request, signal) {
      for (;;) {
        const state = await landState(rpc, github, request);
        if (state) return state;
        await sleep(pollMs, signal);
      }
    },
  };
}

/** One structured turn on the CLI login; the object answer is the targets. */
async function claudePrintExtract(request: Parameters<BuildSurfacePorts["extract"]>[0]): Promise<{ output: unknown; costUsd?: number }> {
  const { prompt, cwd, model, maxBudgetUsd, signal } = request;
  const result = await runAgent({ harness: "claude-print", prompt, cwd, model, outputSchema: z.looseObject({}), maxTurns: 1, maxBudgetUsd, signal });
  if (!result.ok) throw new Error(`${result.failure.kind}: ${result.failure.reason}`);
  return { output: result.output, costUsd: result.usage.totalCostUsd };
}

interface ProductionBuildPorts {
  github: GitHubPort;
  implementer: ImplementerRunner;
  rpc: RpcCall;
}

function systemBuildPorts(given: ProductionBuildPorts): BuildSurfacePorts {
  return {
    now: Date.now,
    readText: (path) => readFile(path, "utf8"),
    run: runCommand,
    readEvidence,
    github: given.github,
    implementer: given.implementer,
    extract: claudePrintExtract,
    shepherd: rpcShepherd(given.rpc, given.github),
    tasks: activeWorkFixTasks({ origin: activeWorkOrigin(process.env) }),
  };
}

interface FactoryAgentWiring {
  port: GitHubPort;
  agentChatBin: string;
  agentChatConfigDir?: string;
  roster?: RosterReader;
  spawnGate?: SpawnGate;
}

/** The implementer and reviewer start through the same roster and spawn gate as every other factory agent. */
export function factoryBuildPorts(wiring: FactoryAgentWiring): BuildSurfacePorts {
  const { agentChatBin, agentChatConfigDir, roster, spawnGate } = wiring;
  const agents = agentChatAgents(agentChatBin, { roster, gate: spawnGate, ...(agentChatConfigDir !== undefined && { configDir: agentChatConfigDir }) });
  return systemBuildPorts({ github: wiring.port, implementer: agentChatImplementerRunner({ agents }), rpc: loopbackRpc });
}
