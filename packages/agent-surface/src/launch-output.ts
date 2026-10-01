import fs from "node:fs";
import path from "node:path";

/**
 * The tail of a headless claude's stderr, kept where the host can read it.
 *
 * The host cannot hold the pipe (see surfaces/headless.ts), so the launcher that
 * outlives it does: it drains claude's stderr, keeps a bounded tail, and leaves it
 * in the agent's directory when claude exits. The host reads the file only to
 * explain a failed launch.
 */
export const OUTPUT_TAIL_BYTES = 4096;

export const outputTailPath = (agentDir: string): string => path.join(agentDir, "stderr-tail.txt");

/** Keeps the last `limit` characters however much is appended. */
export function tailKeeper(limit: number = OUTPUT_TAIL_BYTES): {
  append(chunk: string): void;
  text(): string;
} {
  let kept = "";
  return {
    append: chunk => {
      kept = (kept + chunk).slice(-limit);
    },
    text: () => kept,
  };
}

export function writeOutputTail(agentDir: string, text: string): void {
  if (text === "") return;
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputTailPath(agentDir), text, { mode: 0o600 });
}

/** A resume reuses the agent dir, so a tail from an earlier launch must not outlive it. */
export function clearOutputTail(agentDir: string): void {
  fs.rmSync(outputTailPath(agentDir), { force: true });
}

export function readOutputTail(agentDir: string): string | undefined {
  try {
    return fs.readFileSync(outputTailPath(agentDir), "utf8");
  } catch {
    return undefined;
  }
}

/** What claude prints when no login exists under its config dir. */
const NOT_LOGGED_IN = /not logged in|please run \/login/i;

/** The login diagnosis when `output` carries claude's not-logged-in signature, else undefined. */
export function loginGap(output: string | undefined, configDir: string | undefined): string | undefined {
  if (output === undefined || !NOT_LOGGED_IN.test(output)) return undefined;
  const env = configDir === undefined ? "CLAUDE_CONFIG_DIR unset" : `CLAUDE_CONFIG_DIR=${configDir}`;
  return (
    `Claude Code reported it is not logged in. Run \`claude /login\` with ${env} ` +
    "so the login lands in the config dir this agent uses."
  );
}
