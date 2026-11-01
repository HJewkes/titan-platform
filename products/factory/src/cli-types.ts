import type { Logger } from "@titan-design/daemon";
import type { StepRoute } from "@titan-design/workflow";
import type { BotIdentity } from "./bot-identity.js";
import type { InboxLink } from "./blocker/link.js";
import type { WorkflowDefinition } from "./definition.js";
import type { DeployPorts } from "./deploy.js";
import type { GitBehindProbe } from "./deploy-behind.js";
import type { DeployWatch } from "./deploy-watch.js";
import type { GateNotifyOptions } from "./gate-notify-sweep.js";
import type { ConsoleAnswersOptions } from "./gate-answer-rpc.js";
import type { SourcesReader } from "./github-sources/mode.js";
import type { FactoryHost, FactoryHostOptions, FactoryRoutes } from "./host.js";
import type { PlannerDeps } from "./planner/command.js";
import type { ServeReconciler } from "./reconciler/bot-ports.js";
import type { CheckPorts } from "./service-check.js";
import type { ServicePorts } from "./service-control.js";
import type { ServeIngressOptions } from "./serve-ingress.js";
import type { DeployPacerOptions } from "./shepherd/deploy-pacer.js";
import type { FixerRetirePorts } from "./shepherd/fixer-retire.js";
import type { MainWatchPorts } from "./shepherd/main-watch.js";
import type { HeadRefRead } from "./shepherd/register-identity.js";
import type { SeatDigestPorts } from "./shepherd/seat-digest.js";

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
  /** The serve verb's GitHub sources reader behind health's `sources`; an invalid config throws here, failing the start. */
  sources?: (env: NodeJS.ProcessEnv, log: Logger) => SourcesReader;
  /** The serve verb's webhook ingress listener; absent means serve binds no ingress port. */
  ingress?: (env: NodeJS.ProcessEnv) => ServeIngressOptions;
  /** The serve verb's GitHub backstop, which serve builds over its own bot identity only; absent means serve starts no reconciler. */
  reconciler?: (env: NodeJS.ProcessEnv) => ServeReconciler;
  /** Replaces the bot identity serve reads from the code-fixed token path; tests inject it. No flag or config reaches this. */
  bot?: () => BotIdentity;
  /** The deprecation lines the serve verb logs at start for the config file; absent means it logs none. */
  configDeprecations?: (env: NodeJS.ProcessEnv) => string[];
  /** What `planner wake` runs agent-chat and its input commands through; defaults to the real machine. */
  planner?: PlannerDeps;
  /** What `blocker raise` asks for the inbox link; defaults to the configured titan-console argv. */
  inboxLink?: InboxLink;
  /** Ends the process once serve has closed, so a child an abandoned tick still holds cannot keep it alive; absent means serve returns instead. */
  exitAfterServe?: () => void;
}

export interface Verbs {
  io: CliIo;
  deps: CliDeps;
  dbPath: () => string;
  withHost: (fn: (host: FactoryHost, routes: FactoryRoutes) => Promise<number> | number) => Promise<void>;
  setExit: (code: number) => void;
}
