import { describe, expect, it } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { collectDeclaredNames } from "../declared-names.js";
import { computeSourceMetrics } from "../source-metrics.js";

const FILE = "src/C.tsx";

type Metrics = ReturnType<typeof computeSourceMetrics>;

async function metricsOf(code: string): Promise<Metrics> {
  const file = await parseFile(code, FILE, "typescript");
  return computeSourceMetrics([file], (p) => p, new Map([[FILE, collectDeclaredNames(file)]]));
}

/** The three prop metrics of `symbol`, each undefined when absent. */
function propsOf(metrics: Metrics, symbol: string): { count?: number; bool?: number; unread?: number } {
  const value = (name: string): number | undefined =>
    metrics.find((m) => m.nodeId === `${FILE}#${symbol}` && m.name === name)?.value ?? undefined;
  return { count: value("symbol_prop_count"), bool: value("symbol_bool_prop_count"), unread: value("symbol_unread_props") };
}

describe("component prop metrics (C-97 S3)", () => {
  it("counts own members only when the props interface extends a library type", async () => {
    const metrics = await metricsOf(
      "interface Base { tone: string; }\n" +
        "interface Props extends Base, HTMLAttributes<HTMLDivElement> { open?: boolean; label: string; }\n" +
        "export function Card({ open, label, tone }: Props) {\n  return <div>{open && label}{tone}</div>;\n}\n",
    );

    expect(propsOf(metrics, "Card")).toEqual({ count: 3, bool: 1, unread: 0 });
  });

  it("scores unread 0 when a ...rest element forwards the remaining props", async () => {
    const metrics = await metricsOf(
      "type Props = { a: string; b: number; c?: true | false | undefined };\n" +
        "export function Box({ a, ...rest }: Props) {\n  return <div {...rest}>{a}</div>;\n}\n",
    );

    expect(propsOf(metrics, "Box")).toEqual({ count: 3, bool: 1, unread: 0 });
  });

  it("leaves every prop metric absent for a props type imported from another file", async () => {
    const metrics = await metricsOf(
      'import type { ButtonProps } from "./types";\n' +
        "export function Button({ label }: ButtonProps) {\n  return <button>{label}</button>;\n}\n",
    );

    expect(propsOf(metrics, "Button")).toEqual({ count: undefined, bool: undefined, unread: undefined });
  });

  it("counts a destructured prop whose binding is never referenced as unread", async () => {
    const metrics = await metricsOf(
      "export function Tag({ text, color, hidden }: { text: string; color: string; hidden: boolean }) {\n" +
        "  return <span>{text}</span>;\n}\n",
    );

    expect(propsOf(metrics, "Tag")).toEqual({ count: 3, bool: 1, unread: 2 });
  });

  it("treats props.<name> accesses as reads and a whole-props escape as unread 0", async () => {
    const metrics = await metricsOf(
      "type P = { a: string; b: string; c: string };\n" +
        "export const Read = (props: P) => <i>{props.a}{props.b}</i>;\n" +
        "export const Pass = (props: P) => <Read {...props} />;\n",
    );

    expect(propsOf(metrics, "Read").unread).toBe(1);
    expect(propsOf(metrics, "Pass").unread).toBe(0);
  });

  it("follows & clauses to same-file types and skips the ones it cannot see", async () => {
    const metrics = await metricsOf(
      "type Size = { size: 'sm' | 'lg' };\n" +
        "type Props = Size & Omit<Theirs, 'x'> & { busy: boolean | undefined };\n" +
        "export function Spinner({ size, busy }: Props) {\n  return <svg data-size={size} aria-busy={busy} />;\n}\n",
    );

    expect(propsOf(metrics, "Spinner")).toEqual({ count: 2, bool: 1, unread: 0 });
  });

  it("scores a component with no parameters as having no props", async () => {
    const metrics = await metricsOf("export function Logo() {\n  return <svg />;\n}\n");

    expect(propsOf(metrics, "Logo")).toEqual({ count: 0, bool: 0, unread: 0 });
  });

  it("leaves the metrics absent for an untyped props parameter", async () => {
    const metrics = await metricsOf("export const Row = ({ cells }) => <tr>{cells}</tr>;\n");

    expect(propsOf(metrics, "Row").count).toBeUndefined();
  });

  it("emits nothing for a lowercase function or a PascalCase one that renders no JSX", async () => {
    const metrics = await metricsOf(
      "export function render({ a }: { a: string }) {\n  return <b>{a}</b>;\n}\n" +
        "export function Helper({ a }: { a: string }) {\n  return a;\n}\n",
    );

    expect(metrics.some((m) => m.name.includes("prop"))).toBe(false);
  });

  it("does not count an inner binding that shadows a prop name as a read of that prop", async () => {
    const metrics = await metricsOf(
      "export function Item({ label, count }: { label: string; count: number }) {\n" +
        "  const total = [1].map((count) => count + 1);\n  return <i>{label}{total}</i>;\n}\n",
    );

    expect(propsOf(metrics, "Item").unread).toBe(1);
  });

  it("counts a parenthesized boolean | undefined member as bool", async () => {
    const metrics = await metricsOf(
      "type P = { on?: (boolean | undefined); name: string };\n" +
        "export function Sw({ on, name }: P) {\n  return <b>{on}{name}</b>;\n}\n",
    );

    expect(propsOf(metrics, "Sw")).toEqual({ count: 2, bool: 1, unread: 0 });
  });

  it("gives the same absent answer for an interface extending only imported types and an all-imported intersection", async () => {
    const metrics = await metricsOf(
      'import type { A, B } from "./types";\n' +
        "interface Ext extends A, B {}\n" +
        "type Inter = A & B;\n" +
        "export function One({ x }: Ext) {\n  return <i>{x}</i>;\n}\n" +
        "export function Two({ x }: Inter) {\n  return <i>{x}</i>;\n}\n",
    );

    expect(propsOf(metrics, "One")).toEqual({ count: undefined, bool: undefined, unread: undefined });
    expect(propsOf(metrics, "Two")).toEqual({ count: undefined, bool: undefined, unread: undefined });
  });

  it("does not score PascalCase class methods or getters as components", async () => {
    const metrics = await metricsOf(
      "export class View {\n  Render({ a }: { a: string }) {\n    return <b>{a}</b>;\n  }\n" +
        "  get Body() {\n    return <b />;\n  }\n}\n",
    );

    expect(metrics.some((m) => m.name.includes("prop"))).toBe(false);
  });

  it("leaves props absent for FC<P> and Readonly<P> annotations, whether or not P is declared here", async () => {
    const metrics = await metricsOf(
      "type P = { a: string };\n" +
        "export function Wrapped({ a }: Readonly<P>) {\n  return <i>{a}</i>;\n}\n" +
        "export const Typed: FC<P> = ({ a }) => <i>{a}</i>;\n",
    );

    expect(propsOf(metrics, "Wrapped").count).toBeUndefined();
    expect(propsOf(metrics, "Typed").count).toBeUndefined();
  });

  it("counts a prop read in a nested function's default parameter value as a read", async () => {
    const metrics = await metricsOf(
      "export function A({ label, x }: { label: string; x: number }) {\n" +
        "  const f = (y: string = label) => y;\n  return <i>{f()}{x}</i>;\n}\n",
    );

    expect(propsOf(metrics, "A").unread).toBe(0);
  });

  it.each([
    ["a function parameter", "const f = (label: string) => label;"],
    ["a const in a block", "{ const label = 1; use(label); }"],
    ["a switch case declaration", "switch (x) { case 1: const label = 2; use(label); }"],
    ["a for-of variable", "for (const label of xs) use(label);"],
    ["a for-in variable", "for (const label in xs) use(label);"],
    ["a classic for variable", "for (let label = 0; label < 2; label++) use(label);"],
    ["a catch parameter", "try { go(); } catch (label) { use(label); }"],
    ["an inner function name", "function label() {} use(label);"],
    ["an inner class name", "class label {} use(label);"],
    ["a named function expression", "const g = function label() { return label; };"],
    ["a generator parameter", "function* g(label: string) { yield label; }"],
    ["a generator expression parameter", "const g = function* (label: string) { yield label; };"],
    ["a named generator expression", "const g = function* label() { yield label; };"],
    ["a class expression name", "const K = class label { m() { return label; } };"],
    ["an abstract class name", "abstract class label {} use(label);"],
  ])("does not count %s that shadows a prop as a read of it", async (_kind, inner) => {
    const metrics = await metricsOf(
      "export function Item({ label, x }: { label: string; x: number }) {\n" +
        `  ${inner}\n  return <i>{x}</i>;\n}\n`,
    );

    expect(propsOf(metrics, "Item").unread).toBe(1);
  });

  it("still counts a for-of that assigns to the prop binding without declaring one as no shadow", async () => {
    const metrics = await metricsOf(
      "export function Item({ label }: { label: string }) {\n  for (label of []) use(label);\n  return <i />;\n}\n",
    );

    expect(propsOf(metrics, "Item").unread).toBe(0);
  });

  it("does not count a props.<name> read inside a nested function that shadows props", async () => {
    const metrics = await metricsOf(
      "export function E(props: { a: string; b: string }) {\n" +
        "  const f = (props: { a: number }) => props.a;\n  return <i>{f({ a: 1 })}{props.b}</i>;\n}\n",
    );

    expect(propsOf(metrics, "E").unread).toBe(1);
  });
});
