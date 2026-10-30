import { existsSync, readFileSync } from "node:fs";
import type { ArPorts } from "@titan-design/autoresearch";
import { loadLimits } from "@titan-design/agent-dispatch/limits/node";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost, FactoryRoutes } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { SHEPHERD_COMMAND_MAP } from "../shepherd/commands.js";
import type { ShepherdServices } from "../shepherd/services.js";
import { arAgentPorts } from "./agents.js";
import type { ArConfig } from "./config.js";
import type { ValidatorCase } from "./evaluator.js";
import type { SnapshotWiring } from "./snapshot-ports.js";
import { ownerIdeasPort } from "./inbox.js";
import { arProductionPorts } from "./production.js";
import { arRoutes } from "./routes.js";
import { autoresearchValidateWorkflow, autoresearchWorkflow } from "./workflow.js";

const AGENT_CHAT_TIMEOUT_MS = 60_000;
const AGENT_POLL_MS = 5_000;

const linesOf = (path: string | undefined): string[] =>
  path !== undefined && existsSync(path) ? readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean) : [];

/** A validator line is `<case>` or `<case>\t<caseSet>`. */
const validatorCasesOf = (path: string | undefined): ValidatorCase[] =>
  linesOf(path).map((line) => {
    const [name = line, caseSet] = line.split("\t");
    return caseSet ? { case: name, caseSet } : { case: name };
  });

/** What a snapshot target needs from the host: Shepherd's GitHub port and its in-process register. */
interface SnapshotHost {
  port: SnapshotWiring["port"];
  register: SnapshotWiring["register"];
}

/** Snapshot PRs carry kept search work into the target's code, so Shepherd reviews them as features. */
const SNAPSHOT_KIND = "feature";

/** The same `shepherd.register` command the CLI and serve run (as `handoff.ts` calls it), so a snapshot obeys the seat book and dedupe. */
export function snapshotHost(services: ShepherdServices, hostOf: () => FactoryHost): SnapshotHost {
  const command = SHEPHERD_COMMAND_MAP["shepherd.register"];
  const register: SnapshotHost["register"] = async (request) => {
    const ctx: FactoryContext = { warnings: [], format: "json", host: hostOf(), shepherd: services };
    const { runId, created } = await command.run(command.args.parse({ ...request, kind: SNAPSHOT_KIND }), ctx);
    return { runId, created };
  };
  return { port: services.port, register };
}

function snapshotWiring(config: ArConfig, name: string, host: SnapshotHost | undefined): SnapshotWiring | undefined {
  const snapshot = config.targets[name]?.snapshot;
  if (!snapshot) return undefined;
  if (!host) throw new Error(`[no-shepherd] target ${name} configures snapshots, but this host has no Shepherd services to open and register their PRs`);
  return { ...snapshot, target: name, ...host };
}

/** Every port one configured target's runs use; built once per target, on its first step. */
export function targetPorts(config: ArConfig, name: string, host?: SnapshotHost): ArPorts {
  const target = config.targets[name];
  if (!target) throw new Error(`[no-target] ${name} is not under autoresearch.targets`);
  const { clone } = target;
  const snapshot = snapshotWiring(config, name, host);
  const agents = arAgentPorts({
    clone,
    target: { name, adapterDir: target.adapterDir },
    agentChat: { bin: config.agentChatBin, timeoutMs: AGENT_CHAT_TIMEOUT_MS, pollMs: AGENT_POLL_MS },
    configDir: config.configDir,
    account: config.account,
    profiles: { planner: config.stages.planner.profile, implementer: config.stages.implementer.profile },
    plannerCwd: clone,
    limits: { pool: config.limits.pool, read: () => loadLimits(config.limits.path) },
    load: config.load,
  });
  const evaluator = { clone, workRoot: config.workRoot, archiveDir: config.archiveDir, adapterDir: target.adapterDir, registryPath: config.registryPath, ...(snapshot && { snapshot }) };
  const cases = { caseNames: linesOf(target.caseNamesFile), validatorCases: validatorCasesOf(target.validatorCasesFile) };
  return { ...arProductionPorts({ ...evaluator, ...cases, agents }), ownerIdeas: ownerIdeasPort(config.inboxDir) };
}

type Status = (runId: string) => WorkflowRun | undefined;

/** Ports per run: a run and each of its looks name their target in their params, and each target's ports are built once. */
export function portsForRun(config: ArConfig, status: Status, build: (config: ArConfig, name: string) => ArPorts = targetPorts): (runId: string) => ArPorts {
  const byTarget = new Map<string, ArPorts>();
  return (runId) => {
    const name = status(runId)?.params.target;
    if (name === undefined) throw new Error(`[no-target] run ${runId} names no autoresearch target`);
    const ports = byTarget.get(name) ?? build(config, name);
    byTarget.set(name, ports);
    return ports;
  };
}

interface ArWiring {
  routes: StepRoute[];
  host: Pick<FactoryRoutes, "bindHost" | "workflows" | "autoresearch">;
}

/** The routes, workflows and config a configured host adds; the routes read run params through the host once it is bound. */
function autoresearchWiring(config: ArConfig, shepherd: ShepherdServices | undefined): ArWiring {
  let bound: FactoryHost | undefined;
  const hostOf = () => {
    if (!bound) throw new Error("[no-host] autoresearch routes ran before a host was bound");
    return bound;
  };
  const status: Status = (runId) => hostOf().runtime.status(runId);
  const bindHost = (host: FactoryHost) => ((bound = host), () => void (bound = undefined));
  const workflows = [autoresearchWorkflow(), autoresearchValidateWorkflow()];
  const snapshots = shepherd && snapshotHost(shepherd, hostOf);
  const build = (built: ArConfig, name: string) => targetPorts(built, name, snapshots);
  return { routes: arRoutes(portsForRun(config, status, build)), host: { bindHost, workflows, autoresearch: config } };
}

/** Refused when the host starts, not at a run's first cut, so a snapshot target never runs without a way to open its PRs. */
function refuseSnapshotsWithoutShepherd(config: ArConfig, shepherd: ShepherdServices | undefined): void {
  const wanting = Object.entries(config.targets).filter(([, target]) => target.snapshot !== undefined).map(([name]) => name);
  if (wanting.length > 0 && !shepherd) throw new Error(`[no-shepherd] targets ${wanting.join(", ")} configure snapshots, but this host has no Shepherd services`);
}

/** A copy of `routes` that also hosts autoresearch when it is configured; unconfigured, `routes` itself. */
export function withAutoresearch(routes: FactoryRoutes, config: ArConfig | undefined): FactoryRoutes {
  if (!config) return routes;
  const { database, shepherd, config: configRef, bindHost } = routes;
  if (bindHost) throw new Error("withAutoresearch: the routes already bind a host");
  refuseSnapshotsWithoutShepherd(config, shepherd);
  const wiring = autoresearchWiring(config, shepherd);
  return Object.assign([...routes, ...wiring.routes], { database, shepherd, config: configRef, ...wiring.host });
}
