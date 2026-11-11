import { fakeGitHub, fakeSha, githubPort, type RepoFile } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BUMP_BRANCH_PREFIX, bumpBranch, consumerDepNames, npmLatest, planConsumerBump, readConsumerTree, type ConsumerTree } from "./consumer-bump.js";

const REPO = "acme/consumer-a";
const A = "@titan-design/example-a";
const B = "@titan-design/example-b";
const C = "@titan-design/example-c";

function file(path: string, content: string): RepoFile {
  return { path, content, blobSha: fakeSha(path) };
}

function tree(...manifests: RepoFile[]): ConsumerTree {
  return { repo: REPO, ref: "main", manifests, lockfile: null, workspaceYaml: null, npmrc: null, patches: [] };
}

const latest = (entries: Record<string, string | null>) => new Map(Object.entries(entries));

describe("planConsumerBump", () => {
  it("raises caret, tilde and exact specifiers and keeps the file otherwise byte-identical", () => {
    const before = `{\n  "name": "consumer-a",\n  "dependencies": {\n    "zod": "^4.0.0",\n    "${A}":   "^0.12.1"\n  },\n  "devDependencies": { "${B}": "~0.3.0" },\n  "peerDependencies": {\n\t"${C}": "0.6.1"\n  }\n}\n`;

    const plan = planConsumerBump(tree(file("package.json", before)), latest({ [A]: "0.21.2", [B]: "0.3.1", [C]: "0.6.2" }));

    const after = `{\n  "name": "consumer-a",\n  "dependencies": {\n    "zod": "^4.0.0",\n    "${A}":   "^0.21.2"\n  },\n  "devDependencies": { "${B}": "~0.3.1" },\n  "peerDependencies": {\n\t"${C}": "0.6.2"\n  }\n}\n`;
    expect(plan.files).toEqual([{ path: "package.json", content: after, expectedBlobSha: fakeSha("package.json") }]);
    expect(plan.edits.map(({ name, from, to }) => `${name} ${from} ${to}`)).toEqual([`${A} ^0.12.1 ^0.21.2`, `${B} ~0.3.0 ~0.3.1`, `${C} 0.6.1 0.6.2`]);
    expect(plan.leftAlone).toEqual([]);
  });

  it("a titan pair under pnpm.overrides, overrides or resolutions is left alone with the field as its reason", () => {
    const manifest = file("package.json", JSON.stringify({ pnpm: { overrides: { [A]: "^1.0.0" } }, overrides: { [B]: "1.0.0" }, resolutions: { [C]: "1.0.0", zod: "3.0.0" } }, null, 2));

    const plan = planConsumerBump(tree(manifest), latest({ [A]: "2.0.0", [B]: "2.0.0", [C]: "2.0.0" }));

    expect(plan.edits).toEqual([]);
    expect(plan.files).toEqual([]);
    expect(plan.leftAlone).toEqual([
      { path: "package.json", name: A, spec: "^1.0.0", reason: "pinned by pnpm.overrides" },
      { path: "package.json", name: B, spec: "1.0.0", reason: "pinned by overrides" },
      { path: "package.json", name: C, spec: "1.0.0", reason: "pinned by resolutions" },
    ]);
    expect(consumerDepNames(tree(manifest))).toEqual([A, B, C]);
  });

  it("leaves a dep already on latest unedited", () => {
    const manifest = file("package.json", JSON.stringify({ dependencies: { [A]: "^1.2.3", [B]: "1.0.0" } }, null, 2));

    const mixed = planConsumerBump(tree(manifest), latest({ [A]: "1.2.3", [B]: "1.0.1" }));
    const current = planConsumerBump(tree(manifest), latest({ [A]: "1.2.3", [B]: "1.0.0" }));

    expect(mixed.edits.map(({ name }) => name)).toEqual([B]);
    expect(mixed.files[0]?.content).toContain(`"${A}": "^1.2.3"`);
    expect(current).toEqual({ edits: [], files: [], leftAlone: [] });
  });

  it("leaves workspace:, tags, compound ranges, npm: aliases and 404 names alone with a reason", () => {
    const deps = { [A]: "workspace:*", [B]: "latest", [C]: ">=1.0.0 <2.0.0", "@titan-design/example-d": "npm:other@1.0.0", "@titan-design/example-e": "^1.0.0 || ^2.0.0", "@titan-design/gone": "^1.0.0" };
    const manifest = file("package.json", JSON.stringify({ dependencies: deps }));
    const versions = Object.fromEntries(Object.keys(deps).map((name) => [name, "3.0.0"]));

    const plan = planConsumerBump(tree(manifest), latest({ ...versions, "@titan-design/gone": null }));

    expect(plan.edits).toEqual([]);
    expect(plan.files).toEqual([]);
    expect(plan.leftAlone.map(({ name, reason }) => [name, reason])).toEqual([
      [A, "workspace: specifier"],
      [B, "dist-tag"],
      [C, "compound range"],
      ["@titan-design/example-d", "npm: specifier"],
      ["@titan-design/example-e", "compound range"],
      ["@titan-design/gone", "not on npm"],
    ]);
  });

  it("compares 0.10.0 above 0.9.0 numerically", () => {
    const manifest = file("package.json", JSON.stringify({ dependencies: { [A]: "^0.10.0", [B]: "^0.9.0" } }));

    const plan = planConsumerBump(tree(manifest), latest({ [A]: "0.9.0", [B]: "0.10.0" }));

    expect(plan.edits.map(({ name, to }) => [name, to])).toEqual([[B, "^0.10.0"]]);
  });

  it("ignores a prerelease latest", () => {
    const manifest = file("package.json", JSON.stringify({ dependencies: { [A]: "^0.9.0" } }));

    const plan = planConsumerBump(tree(manifest), latest({ [A]: "1.0.0-rc.1" }));

    expect(plan.edits).toEqual([]);
    expect(plan.files).toEqual([]);
    expect(plan.leftAlone).toEqual([{ path: "package.json", name: A, spec: "^0.9.0", reason: "npm latest 1.0.0-rc.1 is not a plain x.y.z" }]);
  });
});

describe("planConsumerBump override handling", () => {
  const pkg = (value: unknown) => file("package.json", JSON.stringify(value, null, 2));
  const withYaml = (manifest: RepoFile, yaml: string): ConsumerTree => ({ ...tree(manifest), workspaceYaml: file("pnpm-workspace.yaml", yaml) });

  it("rewrites no override field when a dependency and an override carry the same name and spec literal", () => {
    const manifest = pkg({ overrides: { [A]: "^0.12.1" }, pnpm: { overrides: { [A]: "^0.12.1" } }, dependencies: { [A]: "^0.12.1" } });

    const plan = planConsumerBump(tree(manifest), latest({ [A]: "0.21.2" }));

    expect(plan.files).toEqual([]);
    expect(plan.edits).toEqual([]);
  });

  it("bumps a dependency by path when the same literal sits in an unrelated field", () => {
    const manifest = pkg({ dependencies: { [A]: "^0.12.1" }, config: { [A]: "^0.12.1" }, devDependencies: { [A]: "^0.12.1" } });

    const plan = planConsumerBump(tree(manifest), latest({ [A]: "0.21.2" }));

    const written = z.record(z.string(), z.record(z.string(), z.string())).parse(JSON.parse(plan.files[0]?.content ?? "{}"));
    expect([written.dependencies?.[A], written.devDependencies?.[A], written.config?.[A]]).toEqual(["^0.21.2", "^0.21.2", "^0.12.1"]);
  });

  it("leaves a dependency alone when an override pins its name", () => {
    const manifest = pkg({ dependencies: { [A]: "^0.1.0" }, resolutions: { [A]: "0.1.0" } });

    const plan = planConsumerBump(tree(manifest), latest({ [A]: "0.2.0" }));

    expect(plan.files).toEqual([]);
    expect(plan.leftAlone).toContainEqual({ path: "package.json", name: A, spec: "^0.1.0", reason: "pinned by resolutions" });
  });

  it("lists a pin only while it is behind npm latest", () => {
    const manifest = pkg({ pnpm: { overrides: { [A]: "1.0.0", [B]: "1.0.0" } } });

    const plan = planConsumerBump(tree(manifest), latest({ [A]: "1.0.0", [B]: "1.1.0" }));

    expect(plan.leftAlone).toEqual([{ path: "package.json", name: B, spec: "1.0.0", reason: "pinned by pnpm.overrides" }]);
  });

  it("lists pnpm selector keys by their target package", () => {
    const manifest = pkg({ pnpm: { overrides: { [`${A}@^1`]: "1.0.0", [`foo>${B}`]: "1.0.0", [`foo@2>${C}@3`]: "1.0.0", "foo>bar": "1.0.0" } } });

    const plan = planConsumerBump(tree(manifest), latest({ [A]: "2.0.0", [B]: "2.0.0", [C]: "2.0.0" }));

    expect(plan.leftAlone.map(({ name, reason }) => [name, reason])).toEqual([[A, "pinned by pnpm.overrides"], [B, "pinned by pnpm.overrides"], [C, "pinned by pnpm.overrides"]]);
  });

  it("lists npm nested overrides and dot keys by the package they pin", () => {
    const manifest = pkg({ overrides: { foo: { [A]: "1.0.0", bar: { [`${B}@^1`]: "1.0.0" } }, [C]: { ".": "1.0.0", baz: "1.0.0" } } });

    const plan = planConsumerBump(tree(manifest), latest({ [A]: "2.0.0", [B]: "2.0.0", [C]: "2.0.0" }));

    expect(plan.leftAlone.map(({ name, reason }) => [name, reason])).toEqual([[A, "pinned by overrides"], [B, "pinned by overrides"], [C, "pinned by overrides"]]);
  });

  it("lists pnpm-workspace.yaml overrides and keeps dependencies they pin unbumped", () => {
    const manifest = pkg({ dependencies: { [A]: "^0.1.0", [B]: "^0.1.0" } });
    const yaml = `overrides:\n  "${A}": 0.1.0\n  "foo>${C}": 0.1.0\n`;

    const plan = planConsumerBump(withYaml(manifest, yaml), latest({ [A]: "0.2.0", [B]: "0.2.0", [C]: "0.2.0" }));

    expect(plan.edits.map(({ name }) => name)).toEqual([B]);
    expect(plan.leftAlone).toEqual([
      { path: "pnpm-workspace.yaml", name: A, spec: "0.1.0", reason: "pinned by pnpm-workspace.yaml overrides" },
      { path: "pnpm-workspace.yaml", name: C, spec: "0.1.0", reason: "pinned by pnpm-workspace.yaml overrides" },
      { path: "package.json", name: A, spec: "^0.1.0", reason: "pinned by pnpm-workspace.yaml overrides" },
    ]);
    expect(consumerDepNames(withYaml(manifest, yaml))).toEqual([A, B, C]);
  });

  it("keeps a workspace package's dependency unbumped when the root package.json pins it by override", () => {
    const root = file("package.json", JSON.stringify({ pnpm: { overrides: { [A]: "0.1.0" } } }, null, 2));
    const member = file("packages/x/package.json", JSON.stringify({ dependencies: { [A]: "^0.1.0", [B]: "^0.1.0" } }, null, 2));

    const plan = planConsumerBump(tree(root, member), latest({ [A]: "0.2.0", [B]: "0.2.0" }));

    expect(plan.edits.map(({ path, name }) => `${path} ${name}`)).toEqual([`packages/x/package.json ${B}`]);
    expect(plan.leftAlone).toContainEqual({ path: "packages/x/package.json", name: A, spec: "^0.1.0", reason: "pinned by pnpm.overrides" });
  });

  const bumpedNames = (manifest: RepoFile) => planConsumerBump(tree(manifest), latest({ [A]: "0.2.0" })).edits.map(({ name }) => name);

  it("bumps a direct dependency when a pnpm parent-scoped selector names its package", () => {
    expect(bumpedNames(pkg({ dependencies: { [A]: "^0.1.0" }, pnpm: { overrides: { [`foo>${A}`]: "0.1.0" } } }))).toEqual([A]);
  });

  it("bumps a direct dependency when an npm parent-scoped override names its package", () => {
    expect(bumpedNames(pkg({ dependencies: { [A]: "^0.1.0" }, overrides: { foo: { [A]: "0.1.0" } } }))).toEqual([A]);
  });

  it("bumps a direct dependency when a selector range does not match its version", () => {
    expect(bumpedNames(pkg({ dependencies: { [A]: "^0.1.0" }, pnpm: { overrides: { [`${A}@^1`]: "1.0.0" } } }))).toEqual([A]);
  });

  it("keeps a direct dependency unbumped when a selector range matches its version", () => {
    expect(bumpedNames(pkg({ dependencies: { [A]: "^0.1.0" }, pnpm: { overrides: { [`${A}@^0.1.0`]: "0.1.0" } } }))).toEqual([]);
  });

  it("lists an unparseable or glob resolutions key naming a titan package instead of dropping it", () => {
    const manifest = pkg({ resolutions: { [`**/${A}`]: "0.1.0", "@titan-design/*": "0.1.0", "**/zod": "3.0.0" } });

    const plan = planConsumerBump(tree(manifest), latest({}));

    expect(plan.leftAlone).toEqual([
      { path: "package.json", name: `**/${A}`, spec: "0.1.0", reason: "resolutions key not readable as a package selector" },
      { path: "package.json", name: "@titan-design/*", spec: "0.1.0", reason: "resolutions key not readable as a package selector" },
    ]);
  });
});

describe("readConsumerTree", () => {
  function seededPort(files: Record<string, string>) {
    const fake = fakeGitHub();
    for (const [path, content] of Object.entries(files)) fake.files.set(`main:${path}`, { content, blobSha: fakeSha(path) });
    return githubPort(fake.wire);
  }

  it("reads pnpm importers and npm packages workspace manifests", async () => {
    const cliManifest = JSON.stringify({ name: "cli", dependencies: { [A]: "^0.1.0" } });
    const pnpmPort = seededPort({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n\n  packages/cli:\n    dependencies: {}\n",
      "packages/cli/package.json": cliManifest,
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    });
    const npmPort = seededPort({
      "package.json": JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "apps/web": {}, "node_modules/zod": {}, "apps/web/node_modules/left-pad": {}, "node_modules/web": { link: true } } }),
      "apps/web/package.json": JSON.stringify({ name: "web", devDependencies: { [B]: "~0.2.0" } }),
      ".npmrc": "engine-strict=true\n",
    });

    const pnpm = await readConsumerTree(pnpmPort, REPO, "main");
    const npm = await readConsumerTree(npmPort, REPO, "main");

    expect(pnpm.manifests.map(({ path }) => path)).toEqual(["package.json", "packages/cli/package.json"]);
    expect(pnpm.lockfile?.kind).toBe("pnpm");
    expect(pnpm.workspaceYaml?.content).toContain("packages/*");
    expect(consumerDepNames(pnpm)).toEqual([A]);
    expect(npm.manifests.map(({ path }) => path)).toEqual(["package.json", "apps/web/package.json"]);
    expect(npm).toMatchObject({ lockfile: { kind: "npm" }, workspaceYaml: null, npmrc: { content: "engine-strict=true\n" } });
    expect(consumerDepNames(npm)).toEqual([B]);
  });

  it("readConsumerTree reads the patch files a pnpm consumer names", async () => {
    const port = seededPort({
      "package.json": JSON.stringify({ name: "root", pnpm: { patchedDependencies: { "example-a@1.0.0": "patches/example-a.patch" } } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n",
      "pnpm-workspace.yaml": "patchedDependencies:\n  example-b@2.0.0: patches/example-b.patch\n  example-c@3.0.0: patches/example-c.patch\n",
      "patches/example-a.patch": "diff a\n",
      "patches/example-b.patch": "diff b\n",
    });

    const read = await readConsumerTree(port, REPO, "main");

    expect(read.patches.map(({ path, content }) => [path, content])).toEqual([
      ["patches/example-a.patch", "diff a\n"],
      ["patches/example-b.patch", "diff b\n"],
    ]);
  });

  it.each([["../outside.patch"], ["/etc/outside.patch"]])("refuses a patch path outside the repo: %s", async (path) => {
    const port = seededPort({ "package.json": JSON.stringify({ pnpm: { patchedDependencies: { "example-a@1.0.0": path } } }) });

    await expect(readConsumerTree(port, REPO, "main")).rejects.toThrow(/outside the repo/);
  });

  it("refuses a lockfile workspace key that climbs out of the repo", async () => {
    const port = seededPort({ "package.json": "{}", "pnpm-lock.yaml": "importers:\n  ../outside:\n    dependencies: {}\n" });

    await expect(readConsumerTree(port, REPO, "main")).rejects.toThrow(/outside the repo/);
  });
});

describe("bumpBranch", () => {
  it("names the same branch for the same edit set in any order", () => {
    const one = { name: A, version: "0.2.0" };
    const two = { name: B, version: "1.4.0" };

    const forward = bumpBranch([one, two]);
    const backward = bumpBranch([two, one, one]);
    const newer = bumpBranch([one, { ...two, version: "1.5.0" }]);

    expect(forward).toBe(backward);
    expect(forward).toMatch(new RegExp(`^${BUMP_BRANCH_PREFIX}[0-9a-f]{8}$`));
    expect(newer).not.toBe(forward);
  });
});

describe("npmLatest", () => {
  it("reads the latest version and answers null for a name npm does not have", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requested.push(url);
      return url.endsWith("example-a/latest") ? Response.json({ version: "0.4.0" }) : new Response("{}", { status: 404 });
    });
    const lookup = npmLatest(fetchImpl);

    const found = await lookup(A);
    const missing = await lookup("@titan-design/gone");

    expect([found, missing]).toEqual(["0.4.0", null]);
    expect(requested[0]).toBe("https://registry.npmjs.org/@titan-design%2fexample-a/latest");
  });

  it("throws on a registry answer other than 200 or 404", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("", { status: 503 }));

    await expect(npmLatest(fetchImpl)(A)).rejects.toThrow(/503/);
  });
});
