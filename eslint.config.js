import js from "@eslint/js";
import { recommended as titan } from "@titan-design/eslint-plugin";
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
  "packages/tool-guard/src/merge-lint/merge-lint.test.ts",
  "packages/tool-guard/src/shell/procsub-heredoc.test.ts",
];

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
  { languageOptions: { globals: globals.node } },
  { files: ["apps/*/src/**"], languageOptions: { globals: globals.browser } },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
