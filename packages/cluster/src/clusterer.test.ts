import { describe, expect, it } from "vitest";
import { Clusterer } from "./clusterer.js";
import { DrainTreeRegistry } from "./registry.js";
import { templateId } from "./template-id.js";

const bash = (text: string) => ({ partition: "Bash", text });

describe("Clusterer", () => {
  it("mints a template on first sight and reuses it for structurally identical blobs", () => {
    const clusterer = new Clusterer();
    const first = clusterer.cluster(bash("TypeError: Cannot find module src/a.ts"));
    const second = clusterer.cluster(bash("TypeError: Cannot find module src/b.ts"));
    expect(first.isNewTemplate).toBe(true);
    expect(second.isNewTemplate).toBe(false);
    expect(second.templateId).toBe(first.templateId);
    expect(second.maskedSignature).toBe(first.maskedSignature);
    expect(second.maskedSignature).toContain("Cannot find module <PATH>");
    expect(second.extractedParams.PATH).toBe("src/b.ts");
    expect(clusterer.templateCount).toBe(1);
  });

  it("keeps partitions apart even for identical text", () => {
    const clusterer = new Clusterer();
    const a = clusterer.cluster({ partition: "Bash", text: "TypeError: boom" });
    const b = clusterer.cluster({ partition: "Read", text: "TypeError: boom" });
    expect(a.templateId).not.toBe(b.templateId);
    expect(a.templateId).toBe(templateId("Bash", a.maskedSignature));
  });

  it("produces identical template ids across independent runs over the same corpus", () => {
    const corpus = [
      bash("TypeError: Cannot find module a.ts"),
      bash("FAIL suite timeout after 30000 ms"),
      bash("TypeError: Cannot find module b.ts"),
    ];
    const run = () => {
      const c = new Clusterer();
      return corpus.map((b) => c.cluster(b).templateId);
    };
    expect(run()).toEqual(run());
  });

  it("gives Drain-merged lines the id of whichever line founded the cluster", () => {
    const x = bash("TypeError: Cannot find module 'x'");
    const y = bash("TypeError: Cannot find module 'y'");
    const run = (lines: { partition: string; text: string }[]) => {
      const c = new Clusterer();
      return lines.map((line) => c.cluster(line));
    };

    const [xFirst, yAfterX] = run([x, y]);
    const [yFirst, xAfterY] = run([y, x]);

    expect(xFirst!.maskedSignature).not.toBe(yFirst!.maskedSignature);
    expect(yAfterX!.templateId).toBe(xFirst!.templateId);
    expect(xAfterY!.templateId).toBe(yFirst!.templateId);
    expect(xFirst!.templateId).toBe(templateId("Bash", xFirst!.maskedSignature));
    expect(yFirst!.templateId).toBe(templateId("Bash", yFirst!.maskedSignature));
    expect(xFirst!.templateId).not.toBe(yFirst!.templateId);
  });

  it("restores from a snapshot with bindings and learned wildcards intact", () => {
    const first = new Clusterer({ drain: { simTh: 0.5 } });
    const original = first.cluster(bash("error TS1234: Cannot find module a.ts"));
    first.cluster(bash("error TS1234: Cannot find module b.ts"));

    const restored = Clusterer.fromSnapshot(JSON.parse(JSON.stringify(first.snapshot())), { drain: { simTh: 0.5 } });
    const again = restored.cluster(bash("error TS1234: Cannot find module c.ts"));
    expect(again.templateId).toBe(original.templateId);
    expect(again.isNewTemplate).toBe(false);
    expect(restored.templateCount).toBe(1);
    expect(restored.snapshot().partitions[0]!.templateIds).toEqual([[1, original.templateId]]);
  });

  it("reports eviction once a partition hits its cluster cap", () => {
    const clusterer = new Clusterer({ drain: { maxClusters: 2, simTh: 0.99 } });
    expect(clusterer.evicting).toBe(false);
    for (const shape of ["one", "two", "three"]) clusterer.cluster(bash(`Error${shape}: x`));
    expect(clusterer.evicting).toBe(true);
  });

  it("drops the template binding of a cluster the tree evicts", () => {
    const clusterer = new Clusterer({ drain: { maxClusters: 2, simTh: 0.99 } });
    for (const shape of ["one", "two", "three"]) clusterer.cluster(bash(`Error${shape}: x`));
    expect(clusterer.snapshot().partitions[0]!.templateIds).toHaveLength(2);
    expect(clusterer.templateCount).toBe(2);
  });

  it("reports a template as new again when its evicted cluster recurs, under the same id", () => {
    const clusterer = new Clusterer({ drain: { maxClusters: 2, simTh: 0.99 } });
    const first = clusterer.cluster(bash("Errorone: x"));
    for (const shape of ["two", "three"]) clusterer.cluster(bash(`Error${shape}: x`));
    const recurred = clusterer.cluster(bash("Errorone: x"));
    expect(recurred.isNewTemplate).toBe(true);
    expect(recurred.templateId).toBe(first.templateId);
    expect(clusterer.templateCount).toBe(2);
  });

  it("prunes bindings for evicted clusters when loading an older snapshot", () => {
    const options = { drain: { maxClusters: 2, simTh: 0.99 } };
    const source = new Clusterer(options);
    for (const shape of ["one", "two"]) source.cluster(bash(`Error${shape}: x`));
    const snapshot = source.snapshot();
    snapshot.partitions[0]!.templateIds.push([99, "dead-template"]);

    const restored = Clusterer.fromSnapshot(snapshot, options);
    expect(restored.templateCount).toBe(2);
    expect(restored.snapshot().partitions[0]!.templateIds.map(([clusterId]) => clusterId)).toEqual([1, 2]);
  });
});

describe("DrainTreeRegistry", () => {
  it("keeps one isolated tree per partition and snapshots them all", () => {
    const registry = new DrainTreeRegistry();
    expect(registry.getTree("Bash")).toBe(registry.getTree("Bash"));
    registry.getTree("Bash").insert(["error", "a"]);
    registry.getTree("Read").insert(["error", "a"]);
    expect(registry.getTree("Bash").clusterCount).toBe(1);
    expect(registry.partitions.sort()).toEqual(["Bash", "Read"]);
    expect(Object.keys(registry.snapshot()).sort()).toEqual(["Bash", "Read"]);
  });
});
