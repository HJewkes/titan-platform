import { readFileSync } from "node:fs";
import js from "@eslint/js";
import { recommended as titan } from "./packages/eslint-plugin/dist/index.js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const EVENTS_API_MESSAGE =
  "The GitHub Activity Events API is never an event source: it lags 30 s to 6 h. Use a webhook, or read GraphQL timelineItems.";
// The path form is repos|networks/<a>/<b>, orgs|users/<a>, then events (users also received_events), or a bare /events.
const EVENTS_PATH =
  "(^|[\\s'\"`\\x2f])((repos|networks)\\x2f[^\\x2f\\s]+\\x2f[^\\x2f\\s]+\\x2fevents|orgs\\x2f[^\\x2f\\s]+\\x2fevents|users\\x2f[^\\x2f\\s]+\\x2f(received_)?events|^\\x2fevents)([?\\s'\"`]|$)";
// A template splits at each ${}, so a quasi can hold only the tail such as "/events"; the head is not recoverable.
// The tail must end the quasi, so prose such as "the /events hub" and "hold events" stays legal.
const EVENTS_TEMPLATE_TAIL = "(^|[^\\s])\\x2f(received_)?events([?]|$)";
const EVENTS_API_SELECTORS = [
  { selector: `Literal[value=/${EVENTS_PATH}/]`, message: EVENTS_API_MESSAGE },
  { selector: `TemplateElement[value.raw=/${EVENTS_TEMPLATE_TAIL}/]`, message: EVENTS_API_MESSAGE },
  { selector: "MemberExpression[property.name=/^list.*Events/][object.property.name='activity']", message: EVENTS_API_MESSAGE },
  { selector: "MemberExpression[property.name=/^list.*Events/][object.name='activity']", message: EVENTS_API_MESSAGE },
];

const MOTION_PATHS = [
  "/ui/beats/",
  "/motion/",
  "/products/explainer/src/beat-",
  "/products/explainer/src/camera",
  "/products/explainer/src/timing",
  "/products/explainer/src/cues",
  "/products/explainer/src/anchor-grid",
  "/products/explainer/src/storyboard",
  "/products/explainer/src/resolve-beat",
  "/products/explainer/src/composition/",
];

// Tests that still compare a clock with a limit. TP-4264 empties this list and TP-4076 owns the two tool-guard files; only remove entries.
const CLOCK_BUDGET_BASELINE = [
  "apps/console/server/events-relay.test.ts",
  "apps/console/server/rounds-submit.test.ts",
  "packages/anthropic-account/src/node/login.test.ts",
  "packages/anthropic-account/src/node/refresh.test.ts",
  "packages/anthropic-account/src/node/usage-file.test.ts",
  "packages/daemon/src/file-watch.test.ts",
  "packages/daemon/src/lifecycle.test.ts",
  "packages/github/src/octokit-client.test.ts",
  "packages/speech-tts/src/command-tts.test.ts",
  "packages/speech-tts/src/fake-tts.test.ts",
  "packages/speech-tts/src/http-tts.test.ts",
  "packages/tool-guard/src/merge-lint/merge-lint.test.ts",
  "packages/tool-guard/src/shell/procsub-heredoc.test.ts",
];

// Recipe files hold no I/O or clock use outside a step body (TP-3108 D-M1b-07). These files still do; TP-4715 burns the list down, so only remove entries.
const RECIPE_CAPABILITY_BASELINE = [
  "products/factory/src/shepherd/release.ts",
];
const RECIPE_LOOP_BASELINE = [
  "products/factory/src/shepherd/merge-evidence-gate.ts",
  "products/factory/src/shepherd/review-panel-step.ts",
  "products/factory/src/shepherd/stack-land.ts",
  "products/factory/src/workflows/land.ts",
];
const RECIPE_FILES = JSON.parse(readFileSync(new URL("./products/factory/src/recipe-files.json", import.meta.url), "utf8")).map((file) => `products/factory/src/${file}`);
const RECIPE_GLOBAL_MESSAGE = "Reach it through a step body (D-M1b-07).";
const RECIPE_BANNED_GLOBALS = ["Date", "setTimeout", "setInterval", "setImmediate", "fetch", "process", "performance"];
const RECIPE_BANNED_MODULES = ["node:fs", "node:fs/promises", "node:child_process", "node:net", "node:http", "node:https"];
// Only the value exports that build a client; pure helpers such as isPassing stay legal.
const GITHUB_CLIENT_EXPORTS = ["githubPort", "octokitWire", "appInstallationTokenOverHttp"];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".codewatch/**",
      ".codewatch-tool/**",
      // Holds deliberate violations; scripts/eslint-recommended.test.mjs lints it from its own directory.
      "scripts/fixtures/eslint-recommended/**",
      // Holds deliberate Events API uses; scripts/eslint-recommended.test.mjs lints it from its own directory.
      "scripts/fixtures/events-api/**",
      // Holds a deliberate Date.now(); scripts/eslint-recommended.test.mjs lints it from its own directory.
      "scripts/fixtures/wall-clock/**",
      // Holds a deliberate bare gray-matter import; scripts/eslint-recommended.test.mjs lints it from its own directory.
      "scripts/fixtures/gray-matter/**",
      // Holds deliberate recipe-file violations; scripts/eslint-recommended.test.mjs lints it from its own directory.
      "scripts/fixtures/recipe-capabilities/**",
      // Holds a loop under an inline disable in a capability-baseline file; scripts/eslint-recommended.test.mjs lints it from its own directory.
      "scripts/fixtures/recipe-loops/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  titan,
  // A describe or it callback holds a whole suite, so the function limit applies to source only.
  { files: ["**/*.test.{ts,tsx,mts,mjs,js}"], rules: { "titan/max-function-lines": "off" } },
  // Test tables and fixtures hold long data rows by design, so the cap targets packed logic in source.
  {
    files: ["packages/*/src/**", "products/*/src/**"],
    ignores: ["**/*.test.*", "**/fixtures/**", "**/__fixtures__/**", "**/test-support/**"],
    rules: { "titan/max-line-length": ["error", { max: 200 }] },
  },
  // The Activity Events API lags 30 s to 6 h, so it is never an event source (TP-3095 D-M1a-02). GraphQL timelineItems is not it.
  {
    files: ["products/factory/**", "packages/github/**"],
    rules: { "no-restricted-syntax": ["error", ...EVENTS_API_SELECTORS] },
  },
  // A step in a loop has one call site for every pass, so a replay cannot tell the passes apart (TP-3108 H-L3). These files still loop over steps; only remove entries.
  {
    files: RECIPE_FILES,
    ignores: RECIPE_LOOP_BASELINE,
    linterOptions: { noInlineConfig: true },
    rules: { "titan/recipe-step-in-loop": "error" },
  },
  // A recipe sees no client, filesystem or clock: those exist only in step bodies. Inline directives are off per file, the per-file form of --no-inline-config. The block re-lists the Events API selectors because a later block replaces the rule's options.
  {
    files: RECIPE_FILES,
    ignores: RECIPE_CAPABILITY_BASELINE,
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...RECIPE_BANNED_MODULES.map((name) => ({ name, message: RECIPE_GLOBAL_MESSAGE, allowTypeImports: true })),
            { name: "@titan-design/github", importNames: GITHUB_CLIENT_EXPORTS, message: RECIPE_GLOBAL_MESSAGE, allowTypeImports: true },
          ],
          // An adapter module wraps a host effect, so a recipe that imported one would reach the clock, environment or a process through a name the lint does not list.
          patterns: [{ group: ["**/*-adapter.js"], message: "Take the adapter as an input from the code that builds the route (D-M1b-07).", allowTypeImports: true }],
        },
      ],
      "no-restricted-globals": ["error", ...RECIPE_BANNED_GLOBALS.map((name) => ({ name, message: RECIPE_GLOBAL_MESSAGE }))],
      "no-restricted-syntax": ["error", ...EVENTS_API_SELECTORS],
    },
  },
  // Beat and motion code must derive frames from the beat's t, so a seek or a second render matches (TP-4138). The explainer holds no ui/beats or motion dir yet, so its beat, camera, timing and composition page sources are named.
  {
    files: ["**/products/explainer/src/**", "**/ui/beats/**", "**/motion/**"],
    rules: { "titan/no-wall-clock-motion": ["error", { paths: MOTION_PATHS }] },
  },
  // A test that compares elapsed time, or a ratio of times, with a limit fails on a loaded hosted runner: count the work, or time it only under a bench flag (TP-4262).
  {
    files: ["**/*.test.{ts,tsx,mts,mjs}"],
    ignores: CLOCK_BUDGET_BASELINE,
    rules: { "titan/no-test-clock-budget": "error" },
  },
  // A bare gray-matter import evaluates `---js` frontmatter; only the wrapper sets the safe engines (TP-1007).
  {
    files: ["products/active-work/**"],
    ignores: ["products/active-work/src/utils/gray-matter-io.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "gray-matter", message: "Import parseFrontmatter and friends from src/utils/gray-matter-io.ts: a bare gray-matter import executes `---js` frontmatter." }] },
      ],
    },
  },
  // The console times every visible loader as an owner wait (TP-4755); a loader imported straight from react-ui goes untimed.
  {
    files: ["apps/console/src/**/*.{ts,tsx}"],
    ignores: ["apps/console/src/shell/Loading.tsx", "apps/console/src/**/*.test.{ts,tsx}"],
    rules: {
      // A selector, not no-restricted-imports, which would also refuse tree-graph.ts's namespace import that feature-detects an export.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportDeclaration[source.value='@titan-design/react-ui'] > ImportSpecifier[imported.name=/^(Spinner|Skeleton)$/]",
          message: "Import Spinner and Skeleton from src/shell/Loading.tsx, which times each visible loader as a wait.",
        },
      ],
    },
  },
  // A hook called conditionally or after an early return breaks React's call order; only the rules-of-hooks rule is on, not the plugin's compiler rules.
  {
    files: ["apps/*/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
  { languageOptions: { globals: globals.node } },
  { files: ["apps/*/src/**"], languageOptions: { globals: globals.browser } },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
