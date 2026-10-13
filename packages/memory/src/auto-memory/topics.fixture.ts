import { fact } from "./facts.fixture.js";

/** About thirty facts on five topics, phrased with partial overlap, plus three unrelated strays. */
export const TOPIC_FACTS = [
  fact("release-changeset", { description: "Every package change needs a changeset before release" }),
  fact("release-trusted-publisher", { description: "npm trusted publishing runs the release workflow" }),
  fact("release-first-publish", { description: "A new package is published by hand once before release automation" }),
  fact("release-pnpm-publish", { description: "Publish with pnpm so workspace ranges are rewritten" }),
  fact("release-version-pr", { description: "Hold the Version Packages pull request until dependencies publish" }),
  fact("release-no-token", { description: "The release workflow creates no npm token" }),

  fact("spawn-model-tier", { description: "Spawn implementers on the smaller model tier" }),
  fact("spawn-limit", { description: "Spawn at most three agents per coordinator" }),
  fact("spawn-cwd", { description: "A spawned agent runs in its own worktree cwd" }),
  fact("spawn-brief", { description: "Spawned agents get a self-contained brief" }),
  fact("spawn-trust", { description: "Pre-trust the worktree before a spawned agent starts" }),

  fact("ci-gate-drift", { description: "Local gates drift from CI when lint config differs" }),
  fact("ci-lint-warnings", { description: "CI fails on lint warnings in modified files" }),
  fact("ci-typecheck-local", { description: "Run typecheck locally before pushing to CI" }),
  fact("ci-docs-build", { description: "CI runs the docs build on every pull request" }),
  fact("ci-flaky-retry", { description: "Retry a flaky CI job once before debugging" }),
  fact("ci-named-tests", { description: "Run named tests locally, never the full suite before CI" }),
  fact("ci-dag-check", { description: "The dag check gate runs in CI after build" }),

  fact("rebase-stacked", { description: "Rebase stacked pull requests after the parent merges" }),
  fact("rebase-squash", { description: "A squash merge rewrites the parent so stacked branches rebase onto main" }),
  fact("rebase-conflict", { description: "Resolve rebase conflicts in the child branch, not the parent" }),
  fact("rebase-force-push", { description: "Force push with lease after a rebase of a stacked branch" }),

  fact("owner-question-batch", { description: "Batch owner questions into one message" }),
  fact("owner-question-default", { description: "State a default answer when asking the owner a question" }),
  fact("owner-question-unlock", { description: "Ask the owner only for unlock table decisions" }),
  fact("owner-question-park", { description: "Park and hand off after asking the owner a question" }),
  fact("owner-question-voice", { description: "Owner questions in voice mode stay short" }),

  fact("espresso-grind", { description: "Espresso grinder setting fourteen" }),
  fact("tomato-staking", { description: "Tomatoes need staking in June" }),
  fact("tubeless-sealant", { description: "Tubeless tyre sealant lasts three months" }),
];
