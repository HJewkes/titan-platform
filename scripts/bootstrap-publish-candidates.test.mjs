import { describe, expect, it, vi } from "vitest";
import { selectCandidates, selectRequested } from "./bootstrap-publish-candidates.mjs";

const pkg = (name, extra = {}) => ({ dir: `packages/${name.split("/")[1]}`, name, version: "0.1.0", private: false, ...extra });

const registry = (published) => vi.fn(async (name) => published[name] ?? null);

describe("choosing which packages to bootstrap", () => {
  it("publishes a package the registry has never seen", async () => {
    const decisions = await selectCandidates([pkg("@titan-design/messaging")], registry({}));
    expect(decisions).toEqual([{ ...pkg("@titan-design/messaging"), decision: "publish" }]);
  });

  it("skips a package that already has a published version", async () => {
    const view = registry({ "@titan-design/memory": "0.1.1" });
    const [decision] = await selectCandidates([pkg("@titan-design/memory")], view);
    expect(decision).toMatchObject({ decision: "skipped-exists", publishedVersion: "0.1.1" });
  });

  it("skips a private package without asking the registry", async () => {
    const view = registry({});
    const [decision] = await selectCandidates([pkg("@titan-design/internal", { private: true })], view);
    expect(decision).toMatchObject({ decision: "skipped-private" });
    expect(view).not.toHaveBeenCalled();
  });

  it("reports one decision per package, in input order", async () => {
    const view = registry({ "@titan-design/memory": "0.1.1" });
    const decisions = await selectCandidates([pkg("@titan-design/memory"), pkg("@titan-design/messaging")], view);
    expect(decisions.map((d) => [d.name, d.decision])).toEqual([
      ["@titan-design/memory", "skipped-exists"],
      ["@titan-design/messaging", "publish"],
    ]);
  });

  it("propagates a registry failure rather than treating it as a missing package", async () => {
    const view = vi.fn(async () => {
      throw new Error("npm view failed: ETIMEDOUT");
    });
    await expect(selectCandidates([pkg("@titan-design/messaging")], view)).rejects.toThrow(/ETIMEDOUT/);
  });
});

describe("narrowing the run to one requested package", () => {
  const all = [pkg("@titan-design/memory"), pkg("@titan-design/messaging")];

  it("scans every package when no package is requested", () => {
    expect(selectRequested(all, "")).toEqual(all);
  });

  it("matches on the published name", () => {
    expect(selectRequested(all, "@titan-design/messaging")).toEqual([all[1]]);
  });

  it("matches on the directory name under packages/", () => {
    expect(selectRequested(all, "messaging")).toEqual([all[1]]);
  });

  it("fails loudly when nothing matches, rather than publishing the whole workspace", () => {
    expect(() => selectRequested(all, "nope")).toThrow(/no workspace package/);
  });
});
