import type { GraphEdge } from "../types.js";

/**
 * The arguments at one resolved call site (TP-323). `args` holds each positional
 * argument's literal text, or null when it is not a literal. `spreadFrom` is the
 * index of the first `...xs` / `*xs`, after which positions are unknown; `kwargs`
 * and `kwSplat` are Python's keyword arguments and `**kw`.
 */
export interface CallSite {
  args: (string | null)[];
  kwargs?: Record<string, string | null>;
  spreadFrom?: number;
  kwSplat?: true;
}

/**
 * A callable's parameters, stored on its symbol node as `params` and `positionalParams`.
 * `params` excludes `this`, a Python method's receiver, and rest or `**kw` parameters;
 * the first `positional` of them can be passed by position, the rest only by keyword.
 */
export interface ParamShape {
  params: string[];
  positional: number;
}

/** Attrs a `calls` edge carries: every site where the caller calls the callee. */
export interface CallEdgeAttrs {
  sites: CallSite[];
}

/** One `calls` edge per caller and callee pair, with every call site appended to it. */
export function addCallSite(
  agg: Map<string, GraphEdge>,
  srcId: string,
  dstId: string,
  site: CallSite,
): void {
  const key = JSON.stringify([srcId, dstId]);
  const existing = agg.get(key);
  if (existing) (existing.attrs as unknown as CallEdgeAttrs).sites.push(site);
  else agg.set(key, { srcId, dstId, kind: "calls", attrs: { sites: [site] } });
}

/** Symbol-node attrs for a shape; `positionalParams` is written only when some parameter is keyword-only. */
export function paramAttrs(shape: ParamShape | undefined): Record<string, unknown> {
  if (!shape) return {};
  return shape.positional === shape.params.length
    ? { params: shape.params }
    : { params: shape.params, positionalParams: shape.positional };
}

/** Read a shape back off a symbol node's attrs, or undefined for a node that is not a callable. */
export function readParamShape(attrs: Record<string, unknown> | undefined): ParamShape | undefined {
  const params = attrs?.params;
  if (!Array.isArray(params)) return undefined;
  const positional = typeof attrs?.positionalParams === "number" ? attrs.positionalParams : params.length;
  return { params: params as string[], positional };
}
