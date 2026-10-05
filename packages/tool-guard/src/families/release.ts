import type { SimpleCommand } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";
import { classified } from "../spellings.js";
import type { SpellingId } from "../spellings.js";
import type { ClassifiedAction, Family } from "../types.js";
import { ghPrMerge, VERSION_PACKAGES_RE } from "./merge.js";
import { readOptions, set } from "./options.js";

/** Options that take a value, per tool, so their values are not read as subcommands. */
const VALUES: Record<string, ReadonlySet<string>> = {
  npm: set("-w", "--workspace", "-C", "--prefix", "--registry", "--userconfig", "--cache", "--loglevel", "--tag", "--access", "--otp"),
  pnpm: set("--filter", "-F", "-C", "--dir", "--workspace-dir", "--tag", "--access", "--otp", "--registry", "--publish-branch"),
  yarn: set("--cwd", "--tag", "--access", "--new-version", "--otp"),
  bun: set("--cwd", "--tag", "--access", "--otp", "--registry"),
  gh: set("-R", "--repo", "-t", "--title", "-n", "--notes", "-F", "--notes-file", "-f", "--raw-field", "--target", "--ref", "--discussion-category", "--notes-start-tag", "--json"),
  wrangler: set("-c", "--config", "-e", "--env", "--name", "--compatibility-date", "--project-name", "--branch"),
};

/** `pnpm <bin>` and `yarn <bin>` run a package binary; these are the release binaries they may run. */
const BIN_RUNNERS = set("pnpm", "yarn");
const RELEASE_BINS = set("changeset", "@changesets/cli", "wrangler");
const PUBLISH = set("publish", "pub");
const NPM_REGISTRY_MUTATIONS = set("unpublish", "deprecate");
const DIST_TAG_WRITES = set("add", "rm", "remove");
const GH_RELEASE_WRITES = set("create", "edit", "upload", "delete");
const WRANGLER_DEPLOYS = ["deploy", "publish", "versions deploy", "pages deploy", "pages publish"];

/** A workflow named for shipping, or one named by numeric id or at run time, which could be any workflow. */
const RELEASE_WORKFLOW_RE = /release|publish|deploy|^\d+$|[$`]/i;

type Rule = (words: string[]) => SpellingId | null;

const npm: Rule = ([sub, verb]) => {
  if (sub !== undefined && PUBLISH.has(sub)) return "bash.release.npm-publish";
  if (sub !== undefined && NPM_REGISTRY_MUTATIONS.has(sub)) return "bash.release.npm-registry-mutation";
  const distTag = (sub === "dist-tag" || sub === "dist-tags") && verb !== undefined && DIST_TAG_WRITES.has(verb);
  return distTag ? "bash.release.npm-registry-mutation" : null;
};

const pnpm: Rule = ([sub]) => (sub === "publish" ? "bash.release.pnpm-publish" : null);

const yarn: Rule = ([sub, verb]) => (sub === "publish" || (sub === "npm" && verb === "publish") ? "bash.release.yarn-bun-publish" : null);

const changeset: Rule = ([sub]) => (sub === "publish" ? "bash.release.changeset-publish" : null);

const wrangler: Rule = (words) => {
  const deploys = WRANGLER_DEPLOYS.some((d) => words.slice(0, d.split(" ").length).join(" ") === d);
  return deploys ? "bash.release.wrangler-deploy" : null;
};

const gh: Rule = ([group, verb, target]) => {
  if (group === "release" && verb !== undefined && GH_RELEASE_WRITES.has(verb)) return "bash.release.gh-release";
  const releaseWorkflow = group === "workflow" && verb === "run" && target !== undefined && RELEASE_WORKFLOW_RE.test(target);
  return releaseWorkflow ? "bash.release.gh-workflow-run" : null;
};

const RULES: Record<string, Rule> = {
  npm,
  pnpm,
  yarn,
  bun: yarn,
  changeset,
  "@changesets/cli": changeset,
  wrangler,
  gh,
};

/** Tool name and positional words, with `pnpm <bin> ...` read as `<bin> ...`. */
function invocation(cmd: Pick<SimpleCommand, "name" | "args">): { tool: string; words: string[] } | null {
  const tool = cmd.name;
  if (tool === null || !Object.hasOwn(RULES, tool)) return null;
  const words = readOptions(cmd.args, VALUES[tool] ?? set()).positionals.map((w) => w.value);
  const [bin, ...rest] = words;
  if (BIN_RUNNERS.has(tool) && bin !== undefined && RELEASE_BINS.has(bin)) return { tool: bin, words: rest };
  return { tool, words };
}

/** The release tools whose guarded verbs `args` would be if a dynamic command word named them. */
export function releaseNamesFor(args: WordToken[]): string[] {
  return Object.keys(RULES).filter((name) => {
    const call = invocation({ name, args });
    return call !== null && (RULES[call.tool] as Rule)(call.words) !== null;
  });
}

function versionPackages(cmd: SimpleCommand): ClassifiedAction[] {
  const target = ghPrMerge(cmd)?.target;
  if (!target || !VERSION_PACKAGES_RE.test(target.value)) return [];
  return [classified("bash.release.version-packages-merge", { tool: "gh" })];
}

function bash(cmd: SimpleCommand): ClassifiedAction[] {
  const call = invocation(cmd);
  const spelling = call && (RULES[call.tool] as Rule)(call.words);
  const direct = spelling ? [classified(spelling, { tool: call.tool })] : [];
  return [...direct, ...versionPackages(cmd)];
}

/** Publishing packages, cutting releases and deploying: the REL rows of the authority table. */
export const release: Family = { names: set(...Object.keys(RULES)), bash };
