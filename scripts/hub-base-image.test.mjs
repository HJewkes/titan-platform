import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

function hubComposeJob(ci) {
  const start = ci.indexOf("\n  hub-compose:\n");
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[a-z-]+:$/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("the hub base image", () => {
  const dockerfile = read("../deploy/hub/core.Dockerfile");
  const job = hubComposeJob(read("../.github/workflows/ci.yml"));

  it("pins NODE_IMAGE by digest so CI can cache it under that digest", () => {
    expect(dockerfile).toMatch(/^ARG NODE_IMAGE=\S+@sha256:[0-9a-f]{64}$/m);
  });

  it("builds from the cached image instead of pulling the base again", () => {
    expect(job).toContain("key: hub-node-base-${{ steps.base.outputs.digest }}");
    expect(job).toContain("--build-arg NODE_IMAGE=titan-hub-node-base:ci");
  });

  it("falls back to mirror.gcr.io when the ECR pull fails", () => {
    expect(job).toContain("mirror.gcr.io/library/node@");
  });

  it("saves the cache only from main", () => {
    const save = job.slice(job.indexOf("- name: Save base image"));
    expect(save).toMatch(/^\s+if: .*refs\/heads\/main/m);
    expect(save).toContain("actions/cache/save@v4");
  });
});
