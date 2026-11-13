import type { CliDeps, CliIo, Verbs } from "./cli-types.js";
import { registerAudit } from "./audit/command.js";
import { registerBuildSurface } from "./build-surface/command.js";
import { Command, CommanderError } from "commander";
import { configDeprecations, resolveDbPath } from "./config.js";
import { configuredDeployWatch } from "./deploy-watch-ports.js";
import { configuredDeployPacer } from "./deploy-pacer-sweep.js";
import { ghCiTimingPorts } from "./ci-timing-fallback.js";
import { FACTORY_REPO } from "./build-info.js";
import { configuredFixerRetire, configuredMainWatch } from "./main-watch-ports.js";
import { configuredSeatDigest } from "./seat-digest-ports.js";
import { configuredConsoleAnswers } from "./gate-answer-rpc.js";
import { configuredGateNotify } from "./gate-notify-sweep.js";
import { EXIT } from "./exit-codes.js";
import { registerDigest } from "./digest/cli.js";
import { registerQueueCounts } from "./needs/counts.js";
import { registerNeeds } from "./needs/command.js";
import { registerBlocker } from "./blocker/command.js";
import { registerOwnerGates } from "./owner-gates/command.js";
import { registerPlanner } from "./planner/command.js";
import { registerDispatch } from "./eligibility/command.js";
import { registerAutoresearch } from "./autoresearch/cli.js";
import { FROZEN_HOST_WRITE_VERBS, FrozenHostError, refuseFrozenHost } from "./remote-factory.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "./host.js";
import { deployCheckoutFor, registerService } from "./cli-service.js";
import { registerScorecard } from "./cli-scorecard.js";
import { registerReview } from "./review/command.js";
import { registerContextAudit } from "./context-audit/command.js";
import { registerBotToken } from "./cli-bot-token.js";
import { registerToolchain } from "./cli-toolchain.js";
import { registerRelease } from "./cli-release.js";
import { postRpc } from "./cli-shepherd-rpc.js";
import { registerShepherd } from "./cli-shepherd.js";
import { registerLand } from "./cli-land.js";
import { registerMarkers } from "./markers/command.js";
import { registerGate, registerResume, registerServe, routesOf } from "./cli-host-verbs.js";
import { factoryRegistry } from "./registry/steps/index.js";
import { factoryRoutes, factoryWorkflows } from "./workflows.js";
import { sourcesReader } from "./github-sources/mode.js";
import { webhookSecretPath } from "./ingress/paths.js";
import { serveReconciler } from "./reconciler/bot-ports.js";

export { EXIT };
export { formatResume } from "./cli-host-verbs.js";

const defaultIo: CliIo = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), env: process.env };
const defaultDeps: CliDeps = { workflows: factoryWorkflows, host: { registry: factoryRegistry }, routes: factoryRoutes, deployWatch: (env) => configuredDeployWatch(env, deployCheckoutFor(env)), deployPacer: (env) => configuredDeployPacer(env, deployCheckoutFor(env)), mainWatch: configuredMainWatch, fixerRetire: configuredFixerRetire, seatDigest: configuredSeatDigest, ciTimingFallback: () => (FACTORY_REPO === undefined ? undefined : ghCiTimingPorts(FACTORY_REPO)), gateNotify: configuredGateNotify, consoleAnswers: configuredConsoleAnswers, sources: (env, log) => sourcesReader(env, { log }), ingress: (env) => ({ secretPath: webhookSecretPath(env) }), reconciler: serveReconciler, configDeprecations, exitAfterServe: () => process.exit() };

/** Parse argv and run one verb. Returns the exit code instead of exiting, so tests can call it. */
export async function runCli(argv: string[], io: CliIo = defaultIo, deps: CliDeps = defaultDeps): Promise<number> {
  const program = new Command().name("titan-factory").description("Code-driven software-factory workflows").exitOverride();
  program.configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  program.option("--db <path>", "workflow database (TITAN_FACTORY_DB, else the config file, else XDG state)");
  program.option("--factory-config <path>", "config file (TITAN_FACTORY_CONFIG, else $XDG_CONFIG_HOME/titan-factory/config.json)");
  let exitCode: number = EXIT.OK;
  const dbPath = (): string => resolveDbPath({ env: io.env, dbFlag: program.opts<{ db?: string }>().db });
  const setExit = (code: number): void => void (exitCode = code);
  let verb = "";
  program.hook("preAction", (_program, action) => {
    verb = verbPath(action);
    const configFlag = program.opts<{ factoryConfig?: string }>().factoryConfig;
    if (configFlag) io.env.TITAN_FACTORY_CONFIG = configFlag;
    if (FROZEN_HOST_WRITE_VERBS.has(verb)) refuseFrozenHost(io.env, verb);
  });
  const withHost = async (fn: (host: FactoryHost, routes: FactoryRoutes) => Promise<number> | number): Promise<void> => {
    refuseFrozenHost(io.env, verb);
    const routes = routesOf(deps);
    const host = openFactoryHost({ ...deps.host, dbPath: dbPath(), workflows: deps.workflows, routes });
    try {
      exitCode = await fn(host, routes);
    } finally {
      host.close();
    }
  };
  const verbs: Verbs = { io, deps, dbPath, withHost, setExit };
  for (const register of [registerResume, registerGate, registerServe, registerLand, registerShepherd, (p: Command, v: Verbs) => registerDigest(p, v, postRpc), registerQueueCounts, registerNeeds, registerService, registerAudit, registerBuildSurface, registerToolchain, registerRelease, registerScorecard, registerContextAudit, registerOwnerGates, registerBlocker, registerBotToken, registerPlanner, registerDispatch, registerAutoresearch, registerReview, registerMarkers]) register(program, verbs);
  return parse(program, argv, io, () => exitCode);
}

/** `shepherd hold` for the hold subcommand: every command name below the program. */
function verbPath(command: Command): string {
  const names: string[] = [];
  for (let at = command; at.parent; at = at.parent) names.unshift(at.name());
  return names.join(" ");
}

async function parse(program: Command, argv: string[], io: CliIo, exitCode: () => number): Promise<number> {
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) return err.code === "commander.helpDisplayed" || err.code === "commander.version" ? EXIT.OK : EXIT.USAGE;
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof FrozenHostError ? EXIT.USAGE : EXIT.FAILURE;
  }
  return exitCode();
}

