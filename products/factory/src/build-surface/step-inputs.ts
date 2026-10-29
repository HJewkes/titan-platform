/** The JSON each dispatch step carries as its prompt; the route parses it back. */

export interface PlanInput {
  repo: string;
  specPath: string;
}

export interface CommandInput {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ValidateInput {
  argv?: string[];
  cwd: string;
  env: Record<string, string>;
  payload: unknown;
  /** Rejections the workflow found itself, before the repo's validator runs. */
  builtIn: string[];
}

export interface ReportCheckInput extends ValidateInput {
  repo: string;
  branch: string;
  head: string;
}

export interface BranchInput {
  repo: string;
  branch: string;
  base: string;
}

export interface GatesInput extends CommandInput {
  head: string;
  evidenceDir: string;
}

export interface ExtractInput {
  prompt: string;
  model: string;
  maxBudgetUsd: number;
  cwd: string;
}

export interface ImplementInput {
  name: string;
  profile: string;
  cwd: string;
  brief: string;
  task?: string;
}

export interface FixInput {
  name: string;
  message: string;
}

export interface PrInput {
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}

export interface ShepherdInput {
  repo: string;
  pr: number;
  task: string;
  implementer: string;
}

export interface LandInput {
  repo: string;
  pr: number;
  head: string;
}
