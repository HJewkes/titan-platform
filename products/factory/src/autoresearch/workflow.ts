import { AUTORESEARCH_STEPS, AUTORESEARCH_WORKFLOW, runAutoresearch } from "@titan-design/autoresearch";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";

export function autoresearchWorkflow(): WorkflowDefinition {
  return defineWorkflow({ name: AUTORESEARCH_WORKFLOW, steps: AUTORESEARCH_STEPS, run: runAutoresearch });
}
