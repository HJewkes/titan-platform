import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { LatestRegistry } from "../shepherd/consumer-bump.js";
import { MERGE_ON_GREEN_GRANT, type SeatBook } from "../shepherd/seats.js";

/** Behind on a pnpm workspace: the root and `packages/app` both pin older releases. */
export const CONSUMER_A: RepoSlug = "acme/consumer-a";
/** Behind on an npm tree with an exact pin. */
export const CONSUMER_B: RepoSlug = "acme/consumer-b";
/** Already on npm latest. */
export const CONSUMER_C: RepoSlug = "acme/consumer-c";
/** Listed by a seat and denied, so nothing may read it. */
export const CONSUMER_DENIED: RepoSlug = "acme/consumer-denied";

const NPM_LATEST: Readonly<Record<string, string>> = { "@titan-design/example-a": "1.4.0", "@titan-design/example-b": "0.10.0" };

const manifest = (name: string, dependencies: Record<string, string>): string => `${JSON.stringify({ name, dependencies }, null, 2)}\n`;
const pnpmLock = (importers: string[]): string => `lockfileVersion: '9.0'\n\nimporters:\n${importers.map((dir) => `\n  ${dir}:\n    dependencies: {}\n`).join("")}`;

const TREES: Record<RepoSlug, Record<string, string>> = {
  [CONSUMER_A]: {
    "package.json": manifest("consumer-a", { "@titan-design/example-a": "^1.2.0" }),
    "packages/app/package.json": manifest("app", { "@titan-design/example-b": "~0.9.0" }),
    "pnpm-lock.yaml": pnpmLock([".", "packages/app"]),
  },
  [CONSUMER_B]: {
    "package.json": manifest("consumer-b", { "@titan-design/example-b": "0.9.1" }),
    "package-lock.json": `${JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/@titan-design/example-b": {} } }, null, 2)}\n`,
  },
  [CONSUMER_C]: {
    "package.json": manifest("consumer-c", { "@titan-design/example-a": "^1.4.0" }),
    "pnpm-lock.yaml": pnpmLock(["."]),
  },
  [CONSUMER_DENIED]: { "package.json": manifest("consumer-denied", { "@titan-design/example-a": "^1.0.0" }) },
};

/** Two seats with different grants: A's may merge on green, B's (which also lists C and the denied repo) may not. */
export const CONSUMER_SEATS: SeatBook = {
  seats: [
    { name: "seat-a", remotes: [CONSUMER_A], paths: {}, grants: [MERGE_ON_GREEN_GRANT] },
    { name: "seat-bc", remotes: [CONSUMER_B, CONSUMER_C, CONSUMER_DENIED], paths: {}, grants: [] },
  ],
  denied: [CONSUMER_DENIED],
};

export interface ConsumerBumpWorld {
  fakes: Map<RepoSlug, FakeGitHub>;
  port: GitHubPort;
  registry: LatestRegistry;
}

interface ConsumerBumpWorldOptions {
  /** Every `getFile` against this repo throws, as an oversized lockfile does. */
  getFileThrows?: RepoSlug;
}

/** One fake per consumer routed by each call's repo argument, and an npm registry that answers `NPM_LATEST`. */
export function consumerBumpWorld(options: ConsumerBumpWorldOptions = {}): ConsumerBumpWorld {
  const fakes = new Map(Object.entries(TREES).map(([repo, files]) => [repo, seeded(files)]));
  const ports = new Map([...fakes].map(([repo, fake]) => [repo, githubPort(fake.wire)]));
  const portFor = (repo: RepoSlug): GitHubPort => {
    const port = ports.get(repo);
    if (!port) throw new Error(`no fake for ${repo}`);
    return port;
  };
  const port = new Proxy(portFor(CONSUMER_A), {
    get: (_target, method) => (repo: RepoSlug, ...rest: unknown[]) => {
      if (method === "getFile" && repo === options.getFileThrows) return Promise.reject(new Error(`${repo} getFile failed`));
      return Reflect.apply(Reflect.get(portFor(repo), method), undefined, [repo, ...rest]);
    },
  });
  const registry: LatestRegistry = async (name) => NPM_LATEST[name] ?? null;
  return { fakes, port, registry };
}

function seeded(files: Record<string, string>): FakeGitHub {
  const fake = fakeGitHub();
  for (const [path, content] of Object.entries(files)) fake.files.set(`main:${path}`, { content, blobSha: fakeSha(path) });
  return fake;
}
