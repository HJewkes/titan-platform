import type { SessionScan, Snapshot, Spend, InstructionFile } from "./scan.js";

export interface AuditedSession {
  /** The ~/.claude-profiles/<profile> directory the transcript sits under. */
  profile: string;
  /** The project directory name, which encodes the session's cwd. */
  project: string;
  scan: SessionScan;
}

export interface RoleSpend extends Spend {
  sessions: number;
}

export interface Inventory {
  /** `<profile>/<role>`: the profile directory and the role class of the session holding the newest snapshot. */
  key: string;
  role: string;
  snapshot: Snapshot;
  instructions: InstructionFile[];
}

export interface AuditReport {
  spend: Map<string, RoleSpend>;
  inventory: Inventory[];
  carried: Map<string, Map<string, { raw: number; carried: number }>>;
}

/** Role classes by agent name and project directory, as the TP-4164 plan section 0 defines them. */
export function roleOf(project: string, name: string | null): string {
  const n = name ?? "";
  if (n.endsWith("-adversary")) return "adversary";
  if (n.startsWith("rv-")) return "reviewer";
  if (project.includes("-worktrees-")) return "implementer";
  if (project.includes("active-work") && n.endsWith("-plan")) return "planner";
  if (project.includes("active-work") && (n.endsWith("coord") || n.endsWith("operator"))) return "coordinator";
  if (project.includes("active-work")) return "workspace-other";
  return "other";
}

function addSpend(into: RoleSpend, s: Spend): void {
  into.sessions += 1;
  for (const key of ["calls", "turn1", "input", "cacheWrite", "cacheRead", "output", "usd", "unpriced"] as const) into[key] += s[key];
}

function addCarried(into: Map<string, { raw: number; carried: number }>, from: SessionScan["carried"]): void {
  for (const [kind, row] of from) {
    const at = into.get(kind) ?? { raw: 0, carried: 0 };
    at.raw += row.raw;
    at.carried += row.carried;
    into.set(kind, at);
  }
}

export function buildReport(sessions: readonly AuditedSession[]): AuditReport {
  const report: AuditReport = { spend: new Map(), inventory: [], carried: new Map() };
  const newest = new Map<string, Inventory>();
  for (const { profile, project, scan } of sessions) {
    if (scan.spend.calls === 0) continue;
    const role = roleOf(project, scan.name);
    const spend = report.spend.get(role) ?? { sessions: 0, calls: 0, turn1: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, usd: 0, unpriced: 0 };
    addSpend(spend, scan.spend);
    report.spend.set(role, spend);
    if (!report.carried.has(role)) report.carried.set(role, new Map());
    addCarried(report.carried.get(role)!, scan.carried);
    const key = `${profile}/${role}`;
    const held = newest.get(key);
    if (scan.snapshot && (!held || scan.snapshot.at > held.snapshot.at)) newest.set(key, { key, role, snapshot: scan.snapshot, instructions: scan.instructions });
  }
  report.inventory = [...newest.values()].sort((a, b) => a.key.localeCompare(b.key));
  return report;
}

const k = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

function spendLines(spend: AuditReport["spend"]): string[] {
  const rows = [...spend].sort(([, a], [, b]) => b.usd - a.usd);
  const head = `${"role".padEnd(16)}${["sessions", "calls", "turn1", "cache_write", "cache_read", "output", "usd"].map((h) => h.padStart(12)).join("")}`;
  const line = ([role, s]: [string, RoleSpend]): string => {
    const cells = [String(s.sessions), String(s.calls), k(s.turn1 / s.sessions), k(s.cacheWrite), k(s.cacheRead), k(s.output), s.usd.toFixed(2)];
    return `${role.padEnd(16)}${cells.map((c) => c.padStart(12)).join("")}${s.unpriced ? `  (${s.unpriced} calls unpriced)` : ""}`;
  };
  return ["spend by role (turn1 is the mean first-call context; usd is API-equivalent)", head, ...rows.map(line)];
}

function inventoryLines(inv: Inventory): string[] {
  const { snapshot: s } = inv;
  const tools = [...s.tools].sort((a, b) => b.chars - a.chars).map((t) => `${t.name} ${t.chars}`);
  return [
    `inventory ${inv.key} (newest snapshot ${s.at})`,
    `  system prompt: ${s.systemBlocks.length} blocks, ${sum(s.systemBlocks)} chars [${s.systemBlocks.join(", ")}]`,
    `  tool schemas: ${s.tools.length}, ${sum(s.tools.map((t) => t.chars))} chars: ${tools.join(", ")}`,
    ...inv.instructions.map((f) => `  instructions ${f.type} ${f.chars} chars ${f.path}`),
  ];
}

function carriedLines(role: string, kinds: Map<string, { raw: number; carried: number }>, top: number): string[] {
  const total = sum([...kinds.values()].map((r) => r.carried));
  const rows = [...kinds].sort(([, a], [, b]) => b.carried - a.carried).slice(0, top);
  return [
    `carried chars ${role}: ${k(total)} (chars x later calls that re-read them)`,
    ...rows.map(([kind, r]) => `  ${kind.padEnd(32)} raw ${k(r.raw).padStart(7)}  carried ${k(r.carried).padStart(7)}  ${total ? ((100 * r.carried) / total).toFixed(1) : "0.0"}%`),
  ];
}

export function formatReport(report: AuditReport, days: number, top = 15): string {
  const lines = [`context-audit: last ${days} days`, ...spendLines(report.spend)];
  for (const inv of report.inventory) lines.push("", ...inventoryLines(inv));
  for (const [role, kinds] of report.carried) lines.push("", ...carriedLines(role, kinds, top));
  return `${lines.join("\n")}\n`;
}

/** Each listed role must have a snapshot in the window, and every profile's newest snapshot for it must carry the marker. */
export function assertRule(report: AuditReport, marker: string, roles: readonly string[]): { ok: boolean; lines: string[] } {
  const lines = roles.flatMap((role) => {
    const held = report.inventory.filter((inv) => inv.role === role);
    if (!held.length) return [`FAIL ${role}: no prompt_snapshot in the window`];
    return held.map((inv) => {
      const present = inv.snapshot.systemPrompt.includes(marker);
      return `${present ? "PASS" : "FAIL"} ${inv.key}: marker ${present ? "present" : "missing"} (snapshot ${inv.snapshot.at})`;
    });
  });
  return { ok: lines.every((l) => l.startsWith("PASS")), lines };
}
