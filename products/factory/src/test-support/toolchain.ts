import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort, type RepoSlug } from "@titan-design/github";
import { TOOLCHAIN_CONSUMERS } from "../workflows/toolchain-fanout.js";

const CANONICAL_REPO: RepoSlug = "HJewkes/titan-platform";
export const DRIFTED: RepoSlug = "HJewkes/codewatch";
export const ADOPTION_BRANCH = "toolchain/node-24.21.0-pnpm-10.28.1";

const CANONICAL_FILES = {
  ".node-version": "24.21.0\n",
  "package.json": `${JSON.stringify({ name: "titan-platform", packageManager: "pnpm@10.28.1", engines: { node: ">=24 <25" } }, null, 2)}\n`,
};

const DRIFTED_FILES = {
  ".node-version": "22.12.0\n",
  "package.json": `${JSON.stringify({ name: "codewatch", packageManager: "pnpm@9.15.0", engines: { node: ">=22" } }, null, 2)}\n`,
  ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '22'\n",
};

export interface ToolchainWorld {
  fakes: Map<RepoSlug, FakeGitHub>;
  port: GitHubPort;
}

/**
 * One fake per repo, routed by each call's repo argument: titan-platform canonical, codewatch drifted, every other consumer aligned.
 * Real GitHub starts a new branch with its base's files; the fake does not, so the drifted repo's files are seeded on the adoption branch too.
 */
export function toolchainWorld(): ToolchainWorld {
  const fakes = new Map<RepoSlug, FakeGitHub>([[CANONICAL_REPO, seeded(CANONICAL_FILES, ["main"])]]);
  for (const { repo } of TOOLCHAIN_CONSUMERS) fakes.set(repo, repo === DRIFTED ? seeded(DRIFTED_FILES, ["main", ADOPTION_BRANCH]) : seeded(CANONICAL_FILES, ["main"]));
  const ports = new Map([...fakes].map(([repo, fake]) => [repo, githubPort(fake.wire)]));
  const portFor = (repo: RepoSlug): GitHubPort => {
    const port = ports.get(repo);
    if (!port) throw new Error(`no fake for ${repo}`);
    return port;
  };
  const port = new Proxy(portFor(CANONICAL_REPO), {
    get: (_target, method) => (repo: RepoSlug, ...rest: unknown[]) => Reflect.apply(Reflect.get(portFor(repo), method), undefined, [repo, ...rest]),
  });
  return { fakes, port };
}

function seeded(files: Record<string, string>, refs: string[]): FakeGitHub {
  const fake = fakeGitHub();
  for (const ref of refs) for (const [path, content] of Object.entries(files)) fake.files.set(`${ref}:${path}`, { content, blobSha: fakeSha(path) });
  return fake;
}
