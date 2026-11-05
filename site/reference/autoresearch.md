# autoresearch

**Tier 2.** Depends on `workflow` and `rpc-client`.

```sh
npm install @titan-design/autoresearch
```

Inspired by Andrej Karpathy's autoresearch, https://github.com/karpathy/autoresearch (MIT); no code
copied. The package README carries the deviations from it and the papers cited.

## The problem it solves

An agent that edits a system and keeps whatever scores better will keep noise and local wins that
break the system elsewhere. This package is the loop that guards against both: a central planner's
queue, Thompson sampling over idea lineages, a pipelined fidelity ladder per idea, and a keep rule
that needs a gain beyond a measured 2σ band, with guards, gates and zero-tolerance violations.

## When to reach for it

A target can be scored by a frozen command that prints `ar-result/v2`, and you want an unattended
loop that hill-climbs it on a ratchet branch. The metric, its direction, the guards and the gates are
the target's own `target.json` data, so a new target is a directory, not engine code. For a plain
fan-out of agent steps with no keep rule, use `workflow`'s `mapItems`.

## Example

Verified against 0.1.0.

```ts
import { AUTORESEARCH_WORKFLOW, arStepHandlers, arStepId, runAutoresearch, type ArPorts } from "@titan-design/autoresearch";
import { routedRunner, type StepRoute } from "@titan-design/workflow";

declare const ports: ArPorts;

const routes: StepRoute[] = arStepHandlers(ports).map((handler) => ({
  match: arStepId(handler.name),
  onRestart: handler.onRestart,
  runner: { run: async ({ prompt, signal }) => ({ ok: true, output: JSON.stringify({ result: await handler.run(JSON.parse(prompt), signal) }) }) },
}));
const runner = routedRunner(routes);
// new WorkflowRuntime({ db, gates, runner }).register(AUTORESEARCH_WORKFLOW, runAutoresearch, { strictReplay: true })
```

## What it deliberately does not do

- No effects. Worktrees, agents, evaluators, archives and the ratchet push are ports the host
  supplies; the package never calls a model, a shell or git.
- No diff-size cap. Diff size is recorded on each outcome and in the digest, not enforced.
- No bounds post-check on real diffs yet; `preCheck` runs on proposals only.

## Gotchas

- A result that lacks a metric the keep rule reads fails its eval step, and the idea stops with
  `error:ar-eval:…`; it is never judged on a missing value.
- A change class with no `microRung` skips L1 entirely.
- The ratchet step restarts as `park`, so a host restart mid-push waits for a person.

## Where it came from

Extracted from the factory product's first autoresearch slice, then made target-agnostic: the
result schema, the keep rule and the fixture targets name no metric of any one target.
