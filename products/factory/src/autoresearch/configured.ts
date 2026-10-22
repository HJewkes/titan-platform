import { existsSync, readFileSync } from "node:fs";
import type { ArPorts } from "@titan-design/autoresearch";
import { loadLimits } from "@titan-design/agent-dispatch/limits/node";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost, FactoryRoutes } from "../host.js";
import { arAgentPorts } from "./agents.js";
import type { ArConfig } from "./config.js";
import type { ValidatorCase } from "./evaluator.js";
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

/** Every port one configured target's runs use; built once per target, on its first step. */
export function targetPorts(config: ArConfig, name: string): ArPorts {
  const target = config.targets[name];
  if (!target) throw new Error(`[no-target] ${name} is not under autoresearch.targets`);
  const { clone } = target;
  const agents = arAgentPorts({
    clone,
    agentChat: { bin: config.agentChatBin, timeoutMs: AGENT_CHAT_TIMEOUT_MS, pollMs: AGENT_POLL_MS },
    configDir: config.configDir,
    account: config.account,
    profiles: { planner: config.stages.planner.profile, implementer: config.stages.implementer.profile },
    plannerCwd: clone,
    limits: { pool: config.limits.pool, read: () => loadLimits(config.limits.path) },
    load: config.load,
  });
  const evaluator = { clone, workRoot: config.workRoot, archiveDir: config.archiveDir, adapterDir: target.adapterDir, registryPath: config.registryPath };
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

export interface ArWiring {
  routes: StepRoute[];
  host: Pick<FactoryRoutes, "bindHost" | "workflows" | "autoresearch">;
}

/** The routes, workflows and config a configured host adds; the routes read run params through the host once it is bound. */
export function autoresearchWiring(config: ArConfig, build?: (config: ArConfig, name: string) => ArPorts): ArWiring {
  let bound: FactoryHost | undefined;
  const status: Status = (runId) => {
    if (!bound) throw new Error("[no-host] autoresearch routes ran before a host was bound");
    return bound.runtime.status(runId);
  };
  const bindHost = (host: FactoryHost) => ((bound = host), () => void (bound = undefined));
  const workflows = [autoresearchWorkflow(), autoresearchValidateWorkflow()];
  return { routes: arRoutes(portsForRun(config, status, build)), host: { bindHost, workflows, autoresearch: config } };
}

/** A copy of `routes` that also hosts autoresearch when it is configured; unconfigured, `routes` itself. */
export function withAutoresearch(routes: FactoryRoutes, config: ArConfig | undefined): FactoryRoutes {
  if (!config) return routes;
  const wiring = autoresearchWiring(config);
  const { database, shepherd, config: configRef, bindHost } = routes;
  if (bindHost) throw new Error("withAutoresearch: the routes already bind a host");
  return Object.assign([...routes, ...wiring.routes], { database, shepherd, config: configRef, ...wiring.host });
}
