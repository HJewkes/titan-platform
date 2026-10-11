import { dirname, join } from "node:path";
import { z } from "zod";
import { inventoryRows } from "./inventory.js";
import { isEnoent, type ExecResult, type HostPorts } from "./ports.js";

const hostDoctorRowSchema = z.object({
  id: z.string(),
  group: z.enum(["product", "cli", "inventory"]),
  status: z.enum(["ok", "warn", "fail", "missing"]),
  detail: z.string(),
  version: z.string().optional(),
  expected: z.string().optional(),
});

export const hostDoctorReportSchema = z.object({
  host: z.string(),
  platform: z.string(),
  ok: z.boolean(),
  rows: z.array(hostDoctorRowSchema),
});

export type HostDoctorRow = z.infer<typeof hostDoctorRowSchema>;
export type HostDoctorReport = z.infer<typeof hostDoctorReportSchema>;
type Verdict = Pick<HostDoctorRow, "status" | "detail">;

interface Product {
  bin: string;
  /** Path under the projects root to the product's package.json directory. */
  checkout: string[];
  doctor: string[];
  summarize: (result: ExecResult) => Verdict;
}

const PRODUCTS: Product[] = [
  { bin: "active-work", checkout: ["active-work"], doctor: ["doctor", "--json"], summarize: summarizeActiveWork },
  { bin: "agent-chat", checkout: ["agent-chat"], doctor: ["doctor"], summarize: summarizeAgentChat },
  {
    bin: "titan-factory",
    checkout: ["titan-platform", "products", "factory"],
    doctor: ["service", "check", "--json"],
    summarize: summarizeFactory,
  },
];

const TOOLS = ["claude", "chezmoi", "gh", "git", "node", "pnpm"];

interface HostDoctorOptions {
  host: string;
  platform: NodeJS.Platform;
  /** The home directory the inventory's `~` paths resolve against. */
  home: string;
  /** Where the product checkouts live (`~/projects` unless overridden). */
  projectsRoot: string;
}

export async function hostDoctor(ports: HostPorts, options: HostDoctorOptions): Promise<HostDoctorReport> {
  const [toolRows, inventory] = await Promise.all([
    Promise.all([
      ...PRODUCTS.map((product) => productDoctorRow(product, ports)),
      ...PRODUCTS.map((product) => cliRow(product.bin, ports, join(options.projectsRoot, ...product.checkout))),
      ...TOOLS.map((tool) => cliRow(tool, ports)),
    ]),
    inventoryRows(ports, options.home, options.platform),
  ]);
  const rows = [...toolRows, ...inventory];
  return { host: options.host, platform: options.platform, ok: rows.every(isPassing), rows };
}

function isPassing(row: HostDoctorRow): boolean {
  return row.status === "ok" || row.status === "warn";
}

async function productDoctorRow(product: Product, ports: HostPorts): Promise<HostDoctorRow> {
  const id = `doctor:${product.bin}`;
  try {
    const result = await ports.exec(product.bin, product.doctor);
    return { id, group: "product", ...product.summarize(result) };
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { id, group: "product", status: "missing", detail: `${product.bin} is not on PATH` };
  }
}

function summarizeActiveWork(result: ExecResult): Verdict {
  const checks = parseJson(result.stdout, z.object({ data: z.object({ checks: z.array(checkSchema) }) }))?.data.checks;
  if (!checks) return { status: "fail", detail: failureLine(result, "active-work doctor --json printed no report") };
  const failing = checks.filter((check) => check.status !== "ok" && check.status !== "warn");
  if (result.code !== 0 || failing.length > 0) {
    return { status: "fail", detail: failing.map((check) => `${check.name}: ${check.detail}`).join("; ") || failureLine(result, `exit ${result.code}`) };
  }
  const warned = checks.filter((check) => check.status === "warn").map((check) => check.name);
  if (warned.length > 0) return { status: "warn", detail: `${checks.length} checks, warn: ${warned.join(", ")}` };
  return { status: "ok", detail: `${checks.length} checks ok` };
}

const checkSchema = z.object({ name: z.string(), status: z.string(), detail: z.string() });

// agent-chat doctor has no JSON flag; its last line is the verdict.
function summarizeAgentChat(result: ExecResult): Verdict {
  return { status: result.code === 0 ? "ok" : "fail", detail: failureLine(result, `exit ${result.code}`) };
}

function summarizeFactory(result: ExecResult): Verdict {
  if (result.code === 0) return { status: "ok", detail: "service healthy" };
  const report = parseJson(result.stdout, z.object({ cause: z.string(), message: z.string().optional() }));
  if (!report) return { status: "fail", detail: failureLine(result, `exit ${result.code}`) };
  return { status: "fail", detail: report.message ? `${report.cause}: ${report.message}` : report.cause };
}

function parseJson<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function failureLine(result: ExecResult, fallback: string): string {
  const lines = `${result.stdout}\n${result.stderr}`.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? fallback;
}

async function cliRow(bin: string, ports: HostPorts, checkoutDir?: string): Promise<HostDoctorRow> {
  const id = `cli:${bin}`;
  const version = await cliVersion(bin, ports);
  if (version === "missing") return { id, group: "cli", status: "missing", detail: `${bin} is not on PATH` };
  const expected = checkoutDir ? await packageVersion(join(checkoutDir, "package.json"), ports) : null;
  const row: HostDoctorRow = { id, group: "cli", status: "ok", detail: version ?? "present, version unknown" };
  if (version) row.version = version;
  if (!expected) return row;
  row.expected = expected;
  if (version === expected) return row;
  return { ...row, status: "warn", detail: `version mismatch: linked ${version ?? "unknown"}, checkout ${expected}` };
}

const SEMVER = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/** `--version` first; a CLI without one falls back to the package.json beside its linked bin. */
async function cliVersion(bin: string, ports: HostPorts): Promise<string | null | "missing"> {
  try {
    const result = await ports.exec(bin, ["--version"]);
    const match = result.code === 0 ? SEMVER.exec(result.stdout) : null;
    if (match) return match[0];
  } catch (error) {
    if (isEnoent(error)) return "missing";
    throw error;
  }
  const linked = await ports.which(bin);
  return linked ? nearestPackageVersion(dirname(linked), ports) : null;
}

const PACKAGE_SEARCH_DEPTH = 3;

async function nearestPackageVersion(start: string, ports: HostPorts): Promise<string | null> {
  let dir = start;
  for (let depth = 0; depth <= PACKAGE_SEARCH_DEPTH; depth++) {
    const version = await packageVersion(join(dir, "package.json"), ports);
    if (version) return version;
    dir = dirname(dir);
  }
  return null;
}

async function packageVersion(path: string, ports: HostPorts): Promise<string | null> {
  try {
    return parseJson(await ports.readFile(path), z.object({ version: z.string() }))?.version ?? null;
  } catch {
    return null;
  }
}
