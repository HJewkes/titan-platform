import type { GitBehindProbe } from "./deploy-behind.js";
import type { Logger } from "@titan-design/daemon";
import { registerAudit } from "./audit/command.js";
import { Command, CommanderError } from "commander";
import { resolveDbPath } from "./config.js";
import type { DeployPorts } from "./deploy.js";
import type { DeployWatch } from "./deploy-watch.js";
import { configuredDeployWatch } from "./deploy-watch-ports.js";
import { configuredDeployPacer } from "./deploy-pacer-sweep.js";
import type { DeployPacerOptions } from "./shepherd/deploy-pacer.js";
import { configuredFixerRetire, configuredMainWatch } from "./main-watch-ports.js";
import { configuredSeatDigest } from "./seat-digest-ports.js";
import { configuredConsoleAnswers, type ConsoleAnswersOptions } from "./gate-answer-rpc.js";
import { configuredGateNotify, type GateNotifyOptions } from "./gate-notify-sweep.js";
import type { FixerRetirePorts } from "./shepherd/fixer-retire.js";
import { EXIT } from "./exit-codes.js";
import type { OwnerPresence } from "./gate-resolve.js";
import type { WorkflowDefinition } from "./definition.js";
import { registerDigest } from "./digest/cli.js";
import { registerQueueCounts } from "./needs/counts.js";
import { registerNeeds } from "./needs/command.js";
import { registerOwnerGates } from "./owner-gates/command.js";
import { FROZEN_HOST_WRITE_VERBS, FrozenHostError, refuseFrozenHost } from "./remote-factory.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes, type FactoryHostOptions } from "./host.js";
import type { StepRoute } from "@titan-design/workflow";
import { deployCheckoutFor, registerService } from "./cli-service.js";
import { registerScorecard } from "./cli-scorecard.js";
import { registerToolchain } from "./cli-toolchain.js";
import type { CheckPorts } from "./service-check.js";
import type { ServicePorts } from "./service-control.js";
import type { MainWatchPorts } from "./shepherd/main-watch.js";
import type { SeatDigestPorts } from "./shepherd/seat-digest.js";
import { postRpc } from "./cli-shepherd-rpc.js";
import { registerShepherd } from "./cli-shepherd.js";
import { registerLand } from "./cli-land.js";
import { registerGate, registerResume, registerServe, routesOf } from "./cli-host-verbs.js";
import type { HeadRefRead } from "./shepherd/register-identity.js";
import { factoryRoutes, factoryWorkflows } from "./workflows.js";

export { EXIT };
export { formatResume } from "./cli-host-verbs.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

/** What the CLI hosts; tests swap in their own workflows and host settings. */
export interface CliDeps {
  workflows: readonly WorkflowDefinition[];
  /** A function defers building the routes until a verb opens the host. */
  routes: readonly StepRoute[] | (() => FactoryRoutes);
  host?: Partial<Omit<FactoryHostOptions, "dbPath" | "workflows" | "routes">>;
  /** The serve verb's logger; defaults to the console. */
  logger?: Logger;
  /** Stops the serve verb as SIGTERM would. */
  stop?: AbortSignal;
  /** What the service verbs run launchctl, systemctl, claude, fetch and the filesystem through; defaults to the real machine. */
  service?: ServicePorts;
  /** What `service check` reads launchd, ps, /health and the build through; defaults to the real machine. */
  check?: CheckPorts;
  /** What `service deploy` runs git, pnpm and launchctl or systemctl through; defaults to the real machine in this bin's own checkout. */
  deploy?: DeployPorts;
  /** How `gate resolve` asks for owner presence; defaults to the macOS helper. Code only, never argv or env. */
  presence?: OwnerPresence;
  /** What `shepherd register` resolves a bare task ID through; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** How `shepherd register` reads a PR's head branch to infer a missing --task or --implementer; defaults to gh. */
  headRef?: HeadRefRead;
  /** How long a shepherd verb waits on a serve that holds the connection but does not answer; defaults to 20 s. */
  serveWaitMs?: number;
  /** How `shepherd status` reads how far origin/main is past serve's build; defaults to git in the deploy checkout. */
  deployBehind?: GitBehindProbe;
  /** The serve verb's deploy alarm; absent means serve keeps no deploy block and tells no hub seat. */
  deployWatch?: (env: NodeJS.ProcessEnv) => DeployWatch;
  /** The serve verb's deploy pacer, which spawns the deployer for Shepherd's queued sha; absent means serve spawns none. */
  deployPacer?: (env: NodeJS.ProcessEnv) => DeployPacerOptions;
  /** The serve verb's main CI watch; absent, or undefined for an env, means serve watches main only after its own merges. */
  mainWatch?: (env: NodeJS.ProcessEnv) => MainWatchPorts | undefined;
  fixerRetire?: (env: NodeJS.ProcessEnv) => FixerRetirePorts | undefined;
  /** The serve verb's seat digest; absent, or undefined for an env, means serve sends none. */
  seatDigest?: (env: NodeJS.ProcessEnv) => SeatDigestPorts | undefined;
  /** The serve verb's gate notifier; absent, or undefined for an env, means serve posts no gate to agent-chat. */
  gateNotify?: (env: NodeJS.ProcessEnv) => GateNotifyOptions | undefined;
  /** The serve verb's console Ship route; absent, or undefined for an env, means serve does not mount it. */
  consoleAnswers?: (env: NodeJS.ProcessEnv) => ConsoleAnswersOptions | undefined;
  /** Ends the process once serve has closed, so a child an abandoned tick still holds cannot keep it alive; absent means serve returns instead. */
  exitAfterServe?: () => void;
}

const defaultIo: CliIo = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), env: process.env };
const defaultDeps: CliDeps = { workflows: factoryWorkflows, routes: factoryRoutes, deployWatch: (env) => configuredDeployWatch(env, deployCheckoutFor(env)), deployPacer: (env) => configuredDeployPacer(env, deployCheckoutFor(env)), mainWatch: configuredMainWatch, fixerRetire: configuredFixerRetire, seatDigest: configuredSeatDigest, gateNotify: configuredGateNotify, consoleAnswers: configuredConsoleAnswers, exitAfterServe: () => process.exit() };

export interface Verbs {
  io: CliIo;
  deps: CliDeps;
  dbPath: () => string;
  withHost: (fn: (host: FactoryHost, routes: FactoryRoutes) => Promise<number> | number) => Promise<void>;
  setExit: (code: number) => void;
}

/** Parse argv and run one verb. Returns the exit code instead of exiting, so tests can call it. */
export async function runCli(argv: string[], io: CliIo = defaultIo, deps: CliDeps = defaultDeps): Promise<number> {
  const program = new Command().name("titan-factory").description("Code-driven software-factory workflows").exitOverride();
  program.configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  program.option("--db <path>", "workflow database (TITAN_FACTORY_DB, else the config file, else XDG state)");
  let exitCode: number = EXIT.OK;
  const dbPath = (): string => resolveDbPath({ env: io.env, dbFlag: program.opts<{ db?: string }>().db });
  const setExit = (code: number): void => void (exitCode = code);
  let verb = "";
  program.hook("preAction", (_program, action) => {
    verb = verbPath(action);
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
  for (const register of [registerResume, registerGate, registerServe, registerLand, registerShepherd, (p: Command, v: Verbs) => registerDigest(p, v, postRpc), registerQueueCounts, registerNeeds, registerService, registerAudit, registerToolchain, registerScorecard, registerOwnerGates]) register(program, verbs);
  return parse(program, argv, io, () => exitCode);
}

/** `shepherd hold` for the hold subcommand: every command name below the program. */
function verbPath(command: Command): string {
  const names: string[] = [];
  for (let at: Command | null = command; at?.parent; at = at.parent) names.unshift(at.name());
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

