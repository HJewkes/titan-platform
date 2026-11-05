import type { ArPorts } from "@titan-design/autoresearch";
import { evaluatorPorts, type EvaluatorOptions } from "./evaluator.js";

/** The agent side of a run: planner, implementer, trees and the load gate. */
export type AgentPorts = Pick<ArPorts, "plan" | "allocTree" | "implement" | "releaseTree" | "loadWait">;

export interface ProductionOptions extends EvaluatorOptions {
  agents: AgentPorts;
  now?: () => number;
}

/** Every port a real autoresearch run needs: the evaluator effects here, the agent effects passed in. */
export function arProductionPorts({ agents, now = Date.now, ...evaluator }: ProductionOptions): ArPorts {
  return { ...agents, ...evaluatorPorts(evaluator), now };
}
