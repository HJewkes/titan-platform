// Structure checks for the rules in CLAUDE.md that no linter enforces (TP-897 plan S5).
// Each check takes a repo root and returns one remediation message per violation.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { findTiersRule, layersFromTiers, productIsolationRules } from "./new-package.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const WORKSPACE_GROUPS = ["packages", "products", "apps"];
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const SCAFFOLD_SCRIPTS = readJson(new URL("../templates/package/package.json", import.meta.url)).scripts;
const SCAFFOLD_FILES = ["README.md", "CAPABILITY.md", "tsconfig.json", "tsup.config.ts", "src/index.ts"];
const PNPM_PIN = "pnpm@9.15.0";

function subdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isDirectory());
}

function workspaceDirs(root, groups = WORKSPACE_GROUPS) {
  return groups.flatMap((group) => subdirs(join(root, group))).filter((dir) => existsSync(join(dir, "package.json")));
}

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile());
}

/** R34: no relative `file:` dependency in any package.json. */
export function checkNoFileDependencies(root) {
  const manifests = [root, ...workspaceDirs(root)].map((dir) => readJson(join(dir, "package.json")));
  return manifests.flatMap((pkg) =>
    DEPENDENCY_FIELDS.flatMap((field) => Object.entries(pkg[field] ?? {}))
      .filter(([, spec]) => spec.startsWith("file:"))
      .map(([dep]) => {
        const short = dep.replace(/^@titan-design\//, "");
        return `\`${pkg.name}\` depends on \`${short}\` by \`file:\`. Install the published \`@titan-design/${short}\` version from npm.`;
      }),
  );
}

function tiersRule(root) {
  return findTiersRule(readJson(join(root, ".codewatch", "check.json")));
}

/** R41: `layers` is `$tiers` with empty tiers dropped. */
export function checkLayersMatchTiers(root) {
  const rule = tiersRule(root);
  if (JSON.stringify(rule.layers) === JSON.stringify(layersFromTiers(rule.$tiers))) return [];
  return ["`layers` differs from `$tiers`. Edit `$tiers` only, or run `pnpm new:package <name> --tier <t>`."];
}

/** R38: every ordered pair of products has a forbid-import rule. */
export function checkProductIsolation(root) {
  const rules = readJson(join(root, ".codewatch", "check.json")).rules;
  const present = new Set(rules.filter((r) => r.type === "forbid-import").map((r) => `${r.from} ${r.to}`));
  return productIsolationRules(tiersRule(root).$tiers.product)
    .filter((r) => !present.has(`${r.from} ${r.to}`))
    .map(
      (r) =>
        `\`.codewatch/check.json\` lacks rule \`${r.id}\`. Products talk over a CLI, loopback HTTP or MCP. Register products with \`pnpm new:package <name> --tier product\`, which writes these rules.`,
    );
}

/** R43: every package carries the scripts and files the scaffold stamps. */
export function checkScaffold(root) {
  return workspaceDirs(root, ["packages"]).flatMap((dir) => {
    const scripts = readJson(join(dir, "package.json")).scripts ?? {};
    const missing = [
      ...Object.keys(SCAFFOLD_SCRIPTS).filter((s) => !scripts[s]).map((s) => `script ${s}`),
      ...SCAFFOLD_FILES.filter((f) => !existsSync(join(dir, f))),
    ].map((entry) => `lacks \`${entry}\` from the scaffold`);
    const drifted = Object.entries(SCAFFOLD_SCRIPTS)
      .filter(([name, command]) => scripts[name] && scripts[name] !== command)
      .map(([name, command]) => `has \`script ${name}\` that differs from the scaffold (expected \`${command}\`)`);
    return [...missing, ...drifted].map(
      (problem) =>
        `\`${basename(dir)}\` ${problem}. Re-stamp with \`pnpm new:package\`, or fix the entry.`,
    );
  });
}

/** R46: tests live next to source, never in a `__tests__` directory. */
export function checkNoTestsDirectories(root) {
  const testsDirs = workspaceDirs(root, ["packages"])
    .map((dir) => join(dir, "src"))
    .filter(existsSync)
    .flatMap((src) => readdirSync(src, { recursive: true }).map((entry) => join(src, entry)))
    .filter((path) => basename(path) === "__tests__" && statSync(path).isDirectory());
  return testsDirs.flatMap(filesUnder).map((file) => {
    const name = basename(file).replace(/(\.test)?\.[cm]?[jt]sx?$/, "");
    return `Move \`${relative(root, file)}\` next to the source it tests as \`${name}.test.ts\`.`;
  });
}

/** R47: packages take zod as a peer, never a regular dependency. */
export function checkZodIsPeer(root) {
  return workspaceDirs(root, ["packages"])
    .map((dir) => readJson(join(dir, "package.json")))
    .filter((pkg) => pkg.dependencies?.zod)
    .map(
      (pkg) => `\`${pkg.name}\` lists zod under dependencies. Move it to peerDependencies and devDependencies.`,
    );
}

const isYamlComment = (line) => line.trimStart().startsWith("#");

/** R49: no workflow names an npm token; publishing uses the trusted publisher. */
export function checkNoNpmToken(root) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .filter((file) =>
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .some((line) => !isYamlComment(line) && /\b(NPM_TOKEN|NODE_AUTH_TOKEN)\b/.test(line)),
    )
    .map((file) => `\`${file}\` names an npm token. Publishing uses the trusted publisher. Remove the secret.`);
}

/** R51: the pnpm pin stays where release.yml's OIDC publish was tested. */
export function checkPnpmPin(root) {
  if (readJson(join(root, "package.json")).packageManager === PNPM_PIN) return [];
  return [
    "The pnpm pin changed. A pnpm major changes how publish does the OIDC exchange. Revert it, or test a real publish and update this test.",
  ];
}

/** R53: `AGENTS.md` is a byte copy of `CLAUDE.md`. */
export function checkAgentsMatchesClaude(root) {
  const claude = readFileSync(join(root, "CLAUDE.md"));
  if (claude.equals(readFileSync(join(root, "AGENTS.md")))) return [];
  return ["`AGENTS.md` and `CLAUDE.md` differ. Copy `CLAUDE.md` over `AGENTS.md`."];
}

const BUILD_CONFIGS = ["tsup.config.ts", "vite.config.ts"];

/** R54: a build leaves the tracked tree alone, and a build that reads outside its package is never replayed from the turbo cache. */
export function checkTurboBuildContract(root) {
  const messages = [];
  if (readJson(join(root, "turbo.json")).agentGuidance !== false) {
    messages.push("`turbo.json` must set `agentGuidance: false`, or turbo rewrites the tracked `AGENTS.md` during `pnpm build` in an agent session.");
  }
  for (const dir of workspaceDirs(root)) {
    const readsProcess = BUILD_CONFIGS.map((file) => join(dir, file))
      .filter(existsSync)
      .some((path) => readFileSync(path, "utf8").includes("node:child_process"));
    const turboPath = join(dir, "turbo.json");
    const uncached = existsSync(turboPath) && readJson(turboPath).tasks?.build?.cache === false;
    if (readsProcess && !uncached) {
      messages.push(`\`${relative(root, dir)}\` runs a process in its build config. Add a \`turbo.json\` that extends \`//\` and sets \`tasks.build.cache\` to false.`);
    }
  }
  return messages;
}

const isWarn = (setting) => {
  const level = Array.isArray(setting) ? setting[0] : setting;
  return level === "warn" || level === 1;
};

/** R10: no ESLint rule at `warn` severity, presets included. */
export async function checkNoWarnSeverity(root) {
  const configs = [root, ...workspaceDirs(root)]
    .flatMap((dir) => ["eslint.config.js", "eslint.config.mjs"].map((file) => join(dir, file)))
    .filter(existsSync);
  const found = await Promise.all(
    configs.map(async (path) => {
      const entries = [(await import(pathToFileURL(path).href)).default].flat();
      return entries
        .flatMap((entry) => Object.entries(entry?.rules ?? {}))
        .filter(([, setting]) => isWarn(setting))
        .map(([id]) => `Rule \`${id}\` is set to warn in \`${relative(root, path)}\`. Set it to error or remove it. Warnings are not allowed.`);
    }),
  );
  return found.flat();
}

function workspaceGlobs(root) {
  return [...readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").matchAll(/^\s*-\s*["']?([^"'\s#]+)["']?/gm)].map((m) => m[1]);
}

function resolveWorkspaceGlob(root, glob) {
  const dirs = glob.endsWith("/*") ? subdirs(join(root, glob.slice(0, -2))) : [join(root, glob)];
  return dirs.filter((dir) => existsSync(join(dir, "package.json"))).map((dir) => relative(root, dir));
}

/** R55: the root lint command reaches every workspace dir; workspaces carry no lint script of their own. */
export function checkRootLintCoversWorkspaces(root) {
  const targets = (readJson(join(root, "package.json")).scripts?.lint ?? "")
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""));
  const covers = (target, dir) => target === dir || target.startsWith(`${dir}/`) || target.startsWith(`${dirname(dir)}/*/`);
  return workspaceGlobs(root)
    .flatMap((glob) => resolveWorkspaceGlob(root, glob))
    .filter((dir) => !targets.some((target) => covers(target, dir)))
    .map(
      (dir) =>
        `The root \`lint\` script does not reach \`${dir}\`. Add \`${dir}/src\` to it in \`package.json\`; workspaces have no \`lint\` script of their own.`,
    );
}
