import { spawnExec, type Exec, type ExecResult } from "./exec.js";

export interface Call {
  file: string;
  args: readonly string[];
}

export const isSandboxed = (call: Call) => call.file === "sudo" && call.args.includes("setpriv");

export interface StubOptions {
  /** What `id -u` answers for the sandbox user. */
  uid?: number;
  failing?: (args: readonly string[]) => boolean;
  after?: (args: readonly string[]) => void;
}

/**
 * Records every call and stands in for sudo and id without root: a sandboxed call runs the command after setpriv's `--`
 * as this user, and any other sudo call succeeds unless failing says otherwise. after runs once a sandboxed call exits.
 */
export function sudoStub({ uid = 4242, failing = () => false, after = () => undefined }: StubOptions = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, options): Promise<ExecResult> => {
    calls.push({ file, args });
    if (file === "id") return { status: 0, stdout: `${uid}\n`, stderr: "" };
    if (file !== "sudo") return spawnExec(file, args, options);
    if (!args.includes("setpriv")) return { status: failing(args) ? 1 : 0, stdout: "", stderr: "" };
    const command = args.slice(args.indexOf("--", args.indexOf("setpriv")) + 1);
    const result = await spawnExec(command[0] ?? "", command.slice(1), options);
    after(args);
    return result;
  };
  return { calls, exec };
}
