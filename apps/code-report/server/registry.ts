import { loadCheckRules, openCodeGraph } from "@titan-design/code-graph";
import { registerCodeReadCommands, type LiveSource } from "@titan-design/code-read";
import { createRegistry, type BaseContext, type CommandRegistry } from "@titan-design/registry";
import { DB_PATH, REPO_ROOT, RULES_PATH } from "./paths.js";

export interface ReportRegistry {
  registry: CommandRegistry<BaseContext>;
  source: LiveSource;
}

/** The code-read commands over titan-platform's own graph, with its own check rules as the findings. */
export async function createReportRegistry(): Promise<ReportRegistry> {
  const rules = await loadCheckRules(RULES_PATH);
  const registry = createRegistry<BaseContext>();
  const source = registerCodeReadCommands(registry, {
    openStore: () => openCodeGraph(DB_PATH),
    rules: () => rules,
    repoRoot: REPO_ROOT,
  });
  return { registry, source };
}

export function createContext(): BaseContext {
  return { warnings: [], format: "json" };
}
