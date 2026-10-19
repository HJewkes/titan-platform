import { describe, expect, it } from "vitest";
import { classifyGitHubFailure, nextResetAt, type GitHubFailureInput } from "./github-failure.js";

const NOW = 1_800_000_000_000;
const input = (over: Partial<GitHubFailureInput>): GitHubFailureInput => ({ status: 403, headers: {}, message: "", method: "GET", streak: 0, now: NOW, ...over });
const classify = (over: Partial<GitHubFailureInput>) => classifyGitHubFailure(input(over));

describe("classifyGitHubFailure truth table", () => {
  it("C1: a 403 with retry-after waits that many seconds", () => {
    expect(classify({ headers: { "retry-after": "30" } })).toMatchObject({ kind: "unavailable", resetAt: NOW + 30_000, source: "retry-after" });
  });
  it("C2: a 403 with remaining 0 waits to the reset header", () => {
    const reset = NOW / 1000 + 600;
    expect(classify({ headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } })).toMatchObject({ kind: "unavailable", resetAt: reset * 1000, source: "x-ratelimit-reset" });
  });
  it("C3: a header-less 429 waits 60 s", () => {
    expect(classify({ status: 429 })).toMatchObject({ kind: "unavailable", resetAt: NOW + 60_000, source: "backoff" });
  });
  it("C5: the canned 'API rate limit exceeded' 403 waits to its reset", () => {
    const reset = NOW / 1000 + 120;
    const result = classify({ message: "API rate limit exceeded for user ID 1.", headers: { "x-ratelimit-reset": String(reset) } });
    expect(result).toMatchObject({ kind: "unavailable", resetAt: reset * 1000 });
  });
  it("C6: an abuse-detection 403 is unavailable", () => {
    expect(classify({ message: "You have triggered an abuse detection mechanism." }).kind).toBe("unavailable");
  });
  it("C7: a spammed 422 is unavailable", () => {
    expect(classify({ status: 422, method: "POST", message: "This endpoint has been spammed." }).kind).toBe("unavailable");
  });
  it("C8: a permission 403 is an error", () => {
    expect(classify({ message: "Resource not accessible by personal access token" })).toEqual({ kind: "error" });
  });
  it("C9: a validation 422 is an error", () => {
    expect(classify({ status: 422, method: "POST", message: "Validation Failed" })).toEqual({ kind: "error" });
  });
  it("C10: a 502 or network failure on a read is unavailable", () => {
    expect(classify({ status: 502 })).toMatchObject({ kind: "unavailable", resetAt: NOW + 60_000 });
    expect(classify({ status: undefined, networkError: true })).toMatchObject({ kind: "unavailable", callClass: "core-read" });
  });
  it("C11: a 502, timeout or network failure on a write is unknown", () => {
    expect(classify({ status: 502, method: "POST" })).toEqual({ kind: "unknown" });
    expect(classify({ status: undefined, networkError: true, method: "PUT" })).toEqual({ kind: "unknown" });
  });
  it("C12: a 401 is auth", () => {
    expect(classify({ status: 401 })).toEqual({ kind: "auth" });
  });
  it("a success is ok", () => {
    expect(classify({ status: 200 })).toEqual({ kind: "ok" });
  });
  it("C13: the wait doubles from 60 s to a 15 min cap", () => {
    const waits = [0, 1, 2, 3, 4, 5].map((streak) => nextResetAt(NOW, streak) - NOW);
    expect(classify({ status: 429, streak: 3 })).toMatchObject({ resetAt: NOW + 480_000 });
    expect(waits).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    expect(nextResetAt(NOW, 9)).toBe(NOW + 900_000);
  });
  it("C14: retry-after beats x-ratelimit-reset", () => {
    const result = classify({ headers: { "retry-after": "10", "x-ratelimit-reset": String(NOW / 1000 + 500) } });
    expect(result).toMatchObject({ resetAt: NOW + 10_000, source: "retry-after" });
  });
  it("clamps a huge header to 61 min and flags it", () => {
    expect(classify({ headers: { "retry-after": "86400" } })).toMatchObject({ resetAt: NOW + 61 * 60_000, reason: expect.stringContaining("clamped") });
  });
  it("falls back to backoff when the reset header is already past", () => {
    expect(classify({ headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 - 5) } })).toMatchObject({ source: "backoff" });
  });
  it("classes calls and honours x-ratelimit-resource", () => {
    expect(classify({ status: 429, method: "POST", graphql: true })).toMatchObject({ callClass: "graphql", bucket: "graphql" });
    expect(classify({ status: 429, method: "DELETE" })).toMatchObject({ callClass: "mutation", bucket: "core" });
    expect(classify({ status: 429, headers: { "x-ratelimit-resource": "search" } })).toMatchObject({ bucket: "search" });
  });
});

describe("A17: a header-less secondary-limit 403 is Unavailable with a 60 s wait", () => {
  it("is Unavailable with a 60 s wait", () => {
    const result = classify({ method: "POST", message: "You have exceeded a secondary rate limit. Please wait a few minutes." });
    expect(result).toMatchObject({ kind: "unavailable", resetAt: NOW + 60_000, source: "backoff", callClass: "mutation" });
  });
});
