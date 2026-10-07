import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { parseDuration, parseNodePath, parsePort, parseSha } from "./cli-options.js";
import type { CliIo, Verbs } from "./cli.js";
import { factoryStateDir } from "./config.js";
import { deployService } from "./deploy.js";
import { systemDeployPorts } from "./deploy-ports.js";
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
import { systemServicePorts } from "./service-ports.js";

interface PlistFlags {
  port?: number;
  node?: string;
}

const collectDir = (value: string, previous: string[]): string[] => [...previous, value];

const NODE_FLAG = "absolute node binary the service runs; default is this node, mapped off a Homebrew Cellar path";

/** The plist, and the binaries its PATH cannot cover; each of those gets a warning line. */
function plistOptions(io: CliIo, opts: PlistFlags, ports: ServicePorts): { plist: PlistOptions; missing: string[] } {
  const binPath = fileURLToPath(new URL("./bin.js", import.meta.url));
  const nodePath = opts.node ?? stableNodePath(process.execPath);
  const { path, missing } = servicePath(ports.which, nodePath);
  for (const binary of missing) io.stderr(`warning: ${binary} is not on PATH, so the service will not find it\n`);
  return { plist: { binPath, nodePath, logDir: factoryStateDir(io.env), port: opts.port, path }, missing };
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
      verbs.io.stdout(renderServiceFile(ports, plistOptions(verbs.io, opts, ports).plist));
    });
  registerServiceControl(service, verbs);
  registerServiceDeploy(service, verbs);
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
  registerServiceCheck(service, io, deps.check, setExit);
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
const ownCheckout = (): string => fileURLToPath(new URL("../../../", import.meta.url));

function registerServiceDeploy(service: Command, { io, deps, setExit }: Verbs): void {
  const deploy = service
    .command("deploy")
    .description("fast-forward this checkout's main to a sha, rebuild the factory closure and restart drained; restores dist when the new build fails")
    .option("--expect <sha>", "the commit to deploy; default is origin/main after a fetch", parseSha);
  withRestartFlags(deploy).action(async (opts: RestartFlags & { expect?: string }) => {
    const ports = deps.deploy ?? systemDeployPorts(ownCheckout());
    const options = { checkout: ownCheckout(), stateDir: factoryStateDir(io.env), logDir: factoryStateDir(io.env), port: opts.port, expect: opts.expect, drain: drainOf(opts) };
    setExit(await runServiceVerb("deploy", ports, io, () => deployService(ports, io, options), MANAGED_PLATFORMS));
  });
}
