import { METRIC_CATALOGUE } from "./entries.js";
import type { MetricDescriptor } from "./types.js";

const WINDOW_TOKEN = "{w}";
/** Mirrors `windowSuffix` in history-recency.ts, which this module cannot import and stay free of Node. */
const WINDOW_PATTERN = "(\\d+d|lifetime)";

interface WindowedMatcher {
  pattern: RegExp;
  template: MetricDescriptor;
}

const BY_NAME = new Map(METRIC_CATALOGUE.filter((d) => !d.windowed).map((d) => [d.name, d]));

const WINDOWED: readonly WindowedMatcher[] = METRIC_CATALOGUE.filter((d) => d.windowed).map((template) => ({
  pattern: new RegExp(`^${template.name.replace(WINDOW_TOKEN, WINDOW_PATTERN)}$`),
  template,
}));

function resolveWindow(template: MetricDescriptor, window: string): MetricDescriptor {
  const resolved: MetricDescriptor = {
    ...template,
    name: template.name.replace(WINDOW_TOKEN, window),
    description: template.description.replace(WINDOW_TOKEN, window),
    window,
  };
  delete resolved.windowed;
  return resolved;
}

/** The descriptor for a stored metric name, resolving windowed names such as `churn_90d`; null when uncatalogued. */
export function describeMetric(name: string): MetricDescriptor | null {
  const exact = BY_NAME.get(name);
  if (exact) return exact;
  for (const { pattern, template } of WINDOWED) {
    const match = pattern.exec(name);
    if (match) return resolveWindow(template, match[1]!);
  }
  return null;
}

/** Descriptors for a set of stored names, in the order given; uncatalogued names are returned separately. */
export function describeMetrics(names: Iterable<string>): { described: MetricDescriptor[]; unknown: string[] } {
  const described: MetricDescriptor[] = [];
  const unknown: string[] = [];
  for (const name of new Set(names)) {
    const descriptor = describeMetric(name);
    if (descriptor) described.push(descriptor);
    else unknown.push(name);
  }
  return { described, unknown };
}
