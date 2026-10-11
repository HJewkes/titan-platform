import { execFileSync } from "node:child_process";
import { basename } from "./shell/path.js";

/** One process above the hook: whether it runs Claude Code, and whether it has a controlling terminal. */
export interface Ancestor {
  claude: boolean;
  tty: boolean;
}

interface Row {
  ppid: number;
  ancestor: Ancestor;
}

const MAX_DEPTH = 64;
const PS_TIMEOUT_MS = 1000;

/** `ps -o pid= -o ppid= -o tty= -o args=` rows; `args` comes last because it, unlike the others, holds spaces. */
export function parsePs(out: string): Map<number, Row> {
  const rows = new Map<number, Row>();
  for (const line of out.split("\n")) {
    const [pid, ppid, tty, argv0] = line.trim().split(/\s+/);
    if (pid === undefined || ppid === undefined || tty === undefined) continue;
    const ancestor = { claude: basename(argv0 ?? "") === "claude", tty: !/^\?+$/.test(tty) };
    rows.set(Number(pid), { ppid: Number(ppid), ancestor });
  }
  return rows;
}

/** The ancestors of `pid`, nearest first, stopping at init or at a parent `ps` did not list. */
export function ancestorsOf(rows: ReadonlyMap<number, Row>, pid: number): Ancestor[] {
  const out: Ancestor[] = [];
  let row = rows.get(pid);
  while (row !== undefined && row.ppid > 1 && out.length < MAX_DEPTH) {
    const parent = rows.get(row.ppid);
    if (parent === undefined) break;
    out.push(parent.ancestor);
    row = parent;
  }
  return out;
}

/** This process's ancestors; empty when `ps` fails, which withholds the bypass. */
export function readAncestry(): Ancestor[] {
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "tty=", "-o", "args="], { encoding: "utf-8", timeout: PS_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    return ancestorsOf(parsePs(out), process.pid);
  } catch {
    return [];
  }
}
