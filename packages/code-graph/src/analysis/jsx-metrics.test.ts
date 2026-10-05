import { describe, expect, it } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { collectDeclaredNames } from "../declared-names.js";
import { computeSourceMetrics } from "../source-metrics.js";

const FILE = "src/C.tsx";

async function metricsOf(code: string, filePath = FILE): Promise<ReturnType<typeof computeSourceMetrics>> {
  const file = await parseFile(code, filePath, "typescript");
  return computeSourceMetrics([file], (p) => p, new Map([[filePath, collectDeclaredNames(file)]]));
}

function valueOf(metrics: ReturnType<typeof computeSourceMetrics>, nodeId: string, name: string): number | undefined {
  return metrics.find((m) => m.nodeId === nodeId && m.name === name)?.value ?? undefined;
}

const jsxDepth = (metrics: ReturnType<typeof computeSourceMetrics>, symbol: string): number | undefined =>
  valueOf(metrics, `${FILE}#${symbol}`, "symbol_jsx_depth");

describe("JSX tree depth (C-97 S1)", () => {
  it("ten nested Views with no conditionals score jsx depth 10 and nesting 0", async () => {
    const tree = `${"<View>".repeat(10)}${"</View>".repeat(10)}`;
    const metrics = await metricsOf(`export function Deep() {\n  return <>${tree}</>;\n}\n`);

    expect(jsxDepth(metrics, "Deep")).toBe(10);
    expect(valueOf(metrics, `${FILE}#Deep`, "symbol_max_nesting")).toBe(0);
    expect(valueOf(metrics, FILE, "jsx_depth_max")).toBe(10);
    expect(valueOf(metrics, FILE, "max_nesting_depth")).toBe(0);
  });

  it("nests an inline map callback under its container element", async () => {
    const metrics = await metricsOf(
      "export const T = ({ rows }) => (\n  <table><tbody>{rows.map((r) => <Row key={r} />)}</tbody></table>\n);\n",
    );

    expect(jsxDepth(metrics, "T")).toBe(3);
  });

  it("counts attribute JSX one below its owning element", async () => {
    const metrics = await metricsOf("export function B() {\n  return <div><Button icon={<Icon />} /></div>;\n}\n");

    expect(jsxDepth(metrics, "B")).toBe(3);
  });

  it("stops at a nested named function, which scores on its own", async () => {
    const metrics = await metricsOf(
      "export function Outer() {\n  const Inner = () => <a><b><c /></b></a>;\n  return <div><Inner /></div>;\n}\n",
    );

    expect(jsxDepth(metrics, "Outer")).toBe(2);
    expect(jsxDepth(metrics, "Outer.Inner")).toBe(3);
    expect(valueOf(metrics, FILE, "jsx_depth_max")).toBe(3);
  });

  it("includes module-scope JSX in the file maximum", async () => {
    const metrics = await metricsOf("export const icon = <span><svg><path /></svg></span>;\nexport function f() { return 1; }\n");

    expect(valueOf(metrics, FILE, "jsx_depth_max")).toBe(3);
  });

  it("writes neither metric for a function that renders no JSX", async () => {
    const metrics = await metricsOf("export function plain(n: number) {\n  return n + 1;\n}\n", "src/plain.ts");

    expect(metrics.some((m) => m.name === "symbol_jsx_depth" || m.name === "jsx_depth_max")).toBe(false);
  });
});
