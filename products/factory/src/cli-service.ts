import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { parseDuration, parseNodePath, parsePort, parseSha } from "./cli-options.js";
import type { CliIo, Verbs } from "./cli.js";
import { configPath, factoryStateDir, loadConfig, type FactoryConfig } from "./config.js";
import { deployCheckoutPath, deployedBinPath } from "./deploy-checkout.js";
import { deployService, type DeployPorts } from "./deploy.js";
import { clearDeployPause, describePause, readDeployPause } from "./deploy-pause.js";
import { originOf, systemDeployPorts } from "./deploy-ports.js";
import { configuredDeployIncident } from "./deploy-watch-ports.js";
import { DEFAULT_DRAIN_TIMEOUT_MS } from "./restart-drain.js";
import { FACTORY_PORT } from "./serve.js";
import { servicePath, stableNodePath, type PlistOptions } from "./service.js";
import { registerServiceCheck } from "./service-check.js";
import {
  installService,
  MANAGED_PLATFORMS,
  renderServiceFile,
  restartService,
  runServiceVerb,
  serviceStatus,
  uninstallService,
  type RestartDrain,
  type ServicePorts,
} from "./service-control.js";
import { systemCheckPorts, systemServicePorts } from "./service-ports.js";

interface PlistFlags {
  port?: number;
  node?: string;
}

const collectDir = (value: string, previous: string[]): string[] => [...previous, value];

const NODE_FLAG = "absolute node binary the service runs; default is this node, mapped off a Homebrew Cellar path";

/** An unreadable config reads as empty here: the service verbs refuse on it through `ports.configError`. */
function serviceConfig(env: NodeJS.ProcessEnv): NonNullable<FactoryConfig["service"]> {
  try {
    return loadConfig(configPath(env)).service ?? {};
  } catch {
    return {};
  }
}

/** The dedicated deploy checkout, which the unit runs serve from and `service deploy` fast-forwards. */
export const deployCheckoutFor = (env: NodeJS.ProcessEnv, where: { home: string; platform: NodeJS.Platform } = { home: homedir(), platform: process.platform }): string =>
  deployCheckoutPath({ env, home: where.home, platform: where.platform }, serviceConfig(env).deployCheckout);

/** The plist, and the binaries its PATH cannot cover; each of those gets a warning line. */
function plistOptions(io: CliIo, opts: PlistFlags, ports: ServicePorts): { plist: PlistOptions; missing: string[] } {
  const checkout = deployCheckoutFor(io.env, ports);
  const binPath = deployedBinPath(checkout);
  const nodePath = opts.node ?? stableNodePath(process.execPath);
  const { path, missing } = servicePath(ports.which, nodePath);
  for (const binary of missing) io.stderr(`warning: ${binary} is not on PATH, so the service will not find it\n`);
  return { plist: { binPath, nodePath, logDir: factoryStateDir(io.env), port: opts.port, path, workingDirectory: checkout }, missing };
}

export function registerService(program: Command, verbs: Verbs): void {
  const service = program.command("service").description("launchd (macOS) or systemd --user (Linux) service for titan-factory serve");
  service
    .command("plist")
    .description("print the LaunchAgent plist, or on Linux the systemd --user unit; install writes and loads it")
    .option("--port <n>", "port for the serve argument", parsePort)
    .option("--node <path>", NODE_FLAG, parseNodePath)
    .action((opts: PlistFlags) => {
      const ports = verbs.deps.service ?? systemServicePorts();
      if (ports.configError !== undefined) verbs.io.stderr(`warning: printing the default label, because ${ports.configError}\n`);
      verbs.io.stdout(renderServiceFile(ports, plistOptions(verbs.io, opts, ports).plist));
    });
  registerServiceControl(service, verbs);
  registerServiceDeploy(service, verbs);
  registerServicePause(service, verbs);
}

function registerServiceControl(service: Command, { io, deps, setExit }: Verbs): void {
  const run = async (verb: string, fn: (ports: ServicePorts) => Promise<number>): Promise<void> =>
    setExit(await runServiceVerb(verb, deps.service ?? systemServicePorts(), io, fn, MANAGED_PLATFORMS));
  const logDir = factoryStateDir(io.env);
  service
    .command("install")
    .description("write the LaunchAgent plist or systemd --user unit, load it (replacing a loaded one) and wait for /health")
    .option("--port <n>", "port titan-factory serve binds", parsePort)
    .option("--node <path>", NODE_FLAG, parseNodePath)
    .option("--dry-run", "print the file and the launchctl or systemctl calls install would make, and change nothing")
    .option("--mcp", "register the MCP endpoint with claude at user scope")
    .option("--claude-config-dir <dir>", "with --mcp, register in this Claude config dir too (repeatable); default is the caller's profile", collectDir, [])
    .action((opts: PlistFlags & { dryRun?: boolean; mcp?: boolean; claudeConfigDir: string[] }) =>
      run("install", (ports) =>
        installService(ports, io, {
          ...plistOptions(io, opts, ports),
          port: opts.port ?? FACTORY_PORT,
          mcp: opts.mcp === true,
          dryRun: opts.dryRun === true,
          claudeConfigDirs: opts.claudeConfigDir,
          ...(io.env.CLAUDE_CONFIG_DIR ? { callerConfigDir: io.env.CLAUDE_CONFIG_DIR } : {}),
        }),
      ),
    );
  service.command("uninstall").description("unload the LaunchAgent or systemd unit and remove its file").action(() => run("uninstall", (ports) => uninstallService(ports, io)));
  service
    .command("status")
    .description("loaded or not, the pid, and a /health summary; exits 0 only when /health answers and its GitHub check is ok")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action((opts: { port: number }) => run("status", (ports) => serviceStatus(ports, io, opts.port)));
  registerServiceCheck(service, io, () => deps.check ?? systemCheckPorts(deployCheckoutFor(io.env)), setExit);
  withRestartFlags(service.command("restart").description("wait until /health lists no busy run, kill and restart the loaded job, then wait for /health")).action(
    (opts: RestartFlags) => run("restart", (ports) => restartService(ports, io, opts.port, logDir, drainOf(opts))),
  );
}

/** restart and deploy take the same port and drain flags. */
const withRestartFlags = (command: Command): Command =>
  command
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .option("--drain-timeout <duration>", "longest wait for busy runs, such as 45m, 90s or 1h", parseDuration, DEFAULT_DRAIN_TIMEOUT_MS)
    .option("--no-drain", "restart without waiting for busy runs")
    .option("--force", "restart even while a park-routed step is busy");

const drainOf = (opts: RestartFlags): RestartDrain => ({ timeoutMs: opts.drainTimeout, wait: opts.drain, force: opts.force === true });

interface RestartFlags {
  port: number;
  drainTimeout: number;
  drain: boolean;
  force?: boolean;
}

/** The checkout this bin was built in: dist/bin.js and src/cli.ts both sit three levels below its root. */
export const ownCheckout = (): string => fileURLToPath(new URL("../../../", import.meta.url));

function deployPortsFor({ io, deps }: Verbs): { checkout: string; ports: DeployPorts } {
  const checkout = deployCheckoutFor(io.env, { home: deps.deploy?.home ?? homedir(), platform: deps.deploy?.platform ?? process.platform });
  return { checkout, ports: deps.deploy ?? { ...systemDeployPorts(checkout), incident: configuredDeployIncident(io.env) } };
}

function registerServiceDeploy(service: Command, verbs: Verbs): void {
  const { io, deps, setExit } = verbs;
  const deploy = service
    .command("deploy")
    .description("fast-forward the dedicated deploy checkout's main to a sha (cloning it first when absent), rebuild the factory closure, restart drained and watch it; restores dist when the new build fails, and pauses every deploy when a restarted build fails")
    .option("--expect <sha>", "the commit to deploy; default is origin/main after a fetch", parseSha)
    .option("--watch-window <duration>", "how long the restarted build must stay up with no new failed runs, such as 2m; default service.deployWatchMs or 2m", parseDuration);
  withRestartFlags(deploy).action(async (opts: RestartFlags & { expect?: string; watchWindow?: number }) => {
    const { checkout, ports } = deployPortsFor(verbs);
    const config = serviceConfig(io.env);
    const remote = config.deployRemote ?? (deps.deploy === undefined && !existsSync(join(checkout, ".git")) ? await originOf(ownCheckout()) : undefined);
    const windowMs = opts.watchWindow ?? config.deployWatchMs;
    const stateDir = factoryStateDir(io.env);
    const options = { checkout, remote, stateDir, logDir: stateDir, port: opts.port, expect: opts.expect, drain: drainOf(opts), ...(windowMs !== undefined && { watch: { windowMs } }) };
    setExit(await runServiceVerb("deploy", ports, io, () => deployService(ports, io, options), MANAGED_PLATFORMS));
  });
}

/** The pause a rolled-back restart leaves; only a person clears it, since a newer sha must not. */
function registerServicePause(service: Command, verbs: Verbs): void {
  const { io, setExit } = verbs;
  service
    .command("pause")
    .description("show whether a failed deploy has paused every deploy; --clear lifts the pause once the cause is fixed")
    .option("--clear", "remove the pause, so the next deploy runs; refused while a deployer holds the deploy lock")
    .action((opts: { clear?: boolean }) => {
      const { ports } = deployPortsFor(verbs);
      const stateDir = factoryStateDir(io.env);
      const state = readDeployPause(ports, stateDir);
      if (!opts.clear) return void io.stdout(`${describePause(state)}\n`);
      const held = clearDeployPause(ports, stateDir);
      if (held !== undefined) {
        io.stderr(`error: ${held}\n`);
        return setExit(1);
      }
      io.stdout(state.paused ? "cleared the deploy pause\n" : "deploys are not paused\n");
    });
}
