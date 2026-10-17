import { runStatusline } from "./statusline.js";
import type { CliContext, SelectionOptions } from "./context.js";
export type { CliContext } from "./context.js";

const USAGE = "usage: openai-account status --statusline [--code-home <absolute-dir>] [--account <label>] [--expected-account-id <id>]\nExplicit binding opts into native backend quota; native credential refresh may occur. CODEX_HOME is required unless --code-home is given.";

function parse(argv: readonly string[]): SelectionOptions | null {
  if (argv[0] !== "status") return null;
  const options: SelectionOptions = {};
  const seen = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag || seen.has(flag)) return null;
    seen.add(flag);
    if (flag === "--statusline") continue;
    if (flag !== "--code-home" && flag !== "--account" && flag !== "--expected-account-id") return null;
    const value = argv[++i];
    if (!value || value.startsWith("--")) return null;
    if (flag === "--code-home") options.codeHome = value;
    else if (flag === "--account") options.account = value;
    else options.expectedAccountId = value;
  }
  return seen.has("--statusline") ? options : null;
}

/** Syntax errors use fixed text; a valid statusline invocation is quiet and exits zero. */
export async function runCli(argv: readonly string[], context: CliContext): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    context.out(USAGE);
    return 0;
  }
  const options = parse(argv);
  if (!options) { context.err(USAGE); return 64; }
  return runStatusline(options, context);
}
