import { AUTORESEARCH_STEPS, AUTORESEARCH_VALIDATE_STEPS, AUTORESEARCH_VALIDATE_WORKFLOW, AUTORESEARCH_WORKFLOW, runAutoresearch, runValidatorLook } from "@titan-design/autoresearch";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";

export function autoresearchWorkflow(): WorkflowDefinition {
  return defineWorkflow({ name: AUTORESEARCH_WORKFLOW, steps: AUTORESEARCH_STEPS, run: runAutoresearch });
}

export function autoresearchValidateWorkflow(): WorkflowDefinition {
  return defineWorkflow({ name: AUTORESEARCH_VALIDATE_WORKFLOW, steps: AUTORESEARCH_VALIDATE_STEPS, run: runValidatorLook });
}
