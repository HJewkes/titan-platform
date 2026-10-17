export type LoginState =
  | { status: "present"; method: "chatgpt" }
  | { status: "missing" }
  | { status: "refused"; reason: "unsupported-method" | "unrecognized-output" | "probe-failed" };

export interface LoginStatusOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Exact recognized status text only; never return CLI output or credential material. */
export function loginStateFromStatus(output: LoginStatusOutput): LoginState {
  const text = [output.stdout.trim(), output.stderr.trim()].filter(Boolean).join("\n");
  if (output.exitCode === 0 && text === "Logged in using ChatGPT") return { status: "present", method: "chatgpt" };
  if (output.exitCode === 1 && text === "Not logged in") return { status: "missing" };
  if (output.exitCode === 0 && /^Logged in using an API key\b/.test(text)) {
    return { status: "refused", reason: "unsupported-method" };
  }
  return { status: "refused", reason: "unrecognized-output" };
}
