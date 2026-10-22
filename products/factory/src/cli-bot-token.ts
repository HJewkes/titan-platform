import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { BOT_FINGERPRINT_FILE } from "./bot-token-fingerprint.js";
import { scanForBotToken, type ScanReport, type ScanSources } from "./bot-token-scan.js";
import type { Verbs } from "./cli.js";
import { EXIT } from "./exit-codes.js";

interface ScanOpts {
  fingerprint?: string;
  proc?: string;
  briefs?: string[];
  logs?: string[];
  transcripts?: string[];
  store?: string;
  json?: boolean;
}

/** serve's state dir is the database's dir, so the fingerprint, serve's logs and the store default from `--db`. */
function sourcesOf(opts: ScanOpts, env: NodeJS.ProcessEnv, dbPath: string): { fingerprint: string; sources: ScanSources } {
  const home = env.HOME || homedir();
  const agentChat = env.AGENT_CHAT_HOME || join(home, ".agent-chat");
  const claude = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const stateDir = dirname(dbPath);
  return {
    fingerprint: opts.fingerprint ?? join(stateDir, BOT_FINGERPRINT_FILE),
    sources: {
      procRoot: opts.proc ?? "/proc",
      uid: process.getuid?.() ?? -1,
      briefs: opts.briefs ?? [join(agentChat, "agents")],
      logs: opts.logs ?? [stateDir, agentChat],
      transcripts: opts.transcripts ?? [join(claude, "projects")],
      store: opts.store ?? dbPath,
    },
  };
}

function reportText(report: Extract<ScanReport, { state: "scanned" }>): string {
  const head = report.hits.length === 0 ? "bot-token scan: clean" : `bot-token scan: ${report.hits.length} hit(s); revoke the token and rotate it`;
  const hits = report.hits.map((hit) => `HIT ${hit.place} ${hit.where}`);
  const scanned = `scanned ${Object.entries(report.scanned).map(([place, count]) => `${place} ${count}`).join(", ")}`;
  const missing = report.missing.map((gap) => `missing ${gap.place} ${gap.root}`);
  return `${[head, ...hits, scanned, ...missing].join("\n")}\n`;
}

function scanAction(opts: ScanOpts, { io, dbPath, setExit }: Verbs): void {
  const { fingerprint, sources } = sourcesOf(opts, io.env, dbPath());
  const report = scanForBotToken(fingerprint, sources);
  if (report.state === "no-fingerprint") {
    io.stderr(`bot-token scan: no fingerprint at ${fingerprint}; serve has read no bot token, so nothing was checked\n`);
    return setExit(EXIT.UNAVAILABLE);
  }
  io.stdout(opts.json ? `${JSON.stringify(report, null, 2)}\n` : reportText(report));
  setExit(report.hits.length === 0 ? EXIT.OK : EXIT.FAILURE);
}

/** `titan-factory bot-token scan`: A17, the bot's token is absent from every place an agent can read. */
export function registerBotToken(program: Command, verbs: Verbs): void {
  const botToken = program.command("bot-token").description("the bot identity's token, seen only through its fingerprint");
  botToken
    .command("scan")
    .description("run as the agents' uid: hash every token-shaped string in their process environments, agent-chat briefs, serve and agent logs, transcripts and the factory store, and name each place that holds the bot's token (never the token); exits 1 on a hit and 69 with no fingerprint")
    .option("--fingerprint <file>", "serve's published fingerprint (default: bot-token.sha256 beside the database)")
    .option("--proc <dir>", "process root whose <pid>/environ files are read (default /proc)")
    .option("--briefs <dirs...>", "agent-chat brief dirs (default $AGENT_CHAT_HOME/agents)")
    .option("--logs <dirs...>", "dirs whose *.log files are read (default the database's dir and $AGENT_CHAT_HOME)")
    .option("--transcripts <dirs...>", "transcript dirs (default $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects)")
    .option("--store <db>", "factory database to dump (default the --db database)")
    .option("--json", "print the report as JSON")
    .action((opts: ScanOpts) => scanAction(opts, verbs));
}
