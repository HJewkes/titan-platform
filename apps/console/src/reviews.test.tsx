// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { ReviewSummary, getReview } from "../server/reviews.js";
import { App } from "./App.js";

afterEach(cleanup);

type ReviewDetail = Awaited<ReturnType<typeof getReview>>;
type TopicRow = ReviewDetail["topics"][number];

const READ_AT = "2031-04-02T00:00:00.000Z";

function summary(name: string, lastTs: string | null, overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    name, remote: `https://github.com/acme/${name}`, head: "0123456789abcdef0123456789abcdef01234567", readmeStatus: null,
    label: "final", state: "final", p1: 1, p2: 2, topics: 6, claims: 2, unread: 0,
    cost: lastTs === null ? null : { usd: 1.5, calls: 3, errors: 0, lastTs },
    ...overrides,
  };
}

function topic(topic_id: string, priority: string, verdict: string, line: number): TopicRow {
  return { topic_id, tier: "core", title: `Topic ${topic_id}`, verdict, priority, titan_evidence: "", reason: `Why ${topic_id}`, line, extra: {} };
}

const LIST = {
  reviews: [summary("widget-kit", "2031-03-01T10:00:00Z"), summary("acme-tool", "2031-03-20T10:00:00Z"), summary("orbit-cli", null, { state: "pinned", label: null })],
  gaps: ["orbit-cli: topics-judged.tsv header lacks priority"],
  readAt: READ_AT,
};

const TOPICS = [
  topic("ACM-1", "P2", "missing", 2),
  topic("ACM-2", "P1", "already-have", 3),
  topic("ACM-3", "P3", "missing", 4),
  topic("ACM-4", "P1", "have-worse", 5),
  topic("ACM-5", "P4", "lost", 6),
  topic("ACM-6", "P2", "lost", 7),
];

const DETAIL: ReviewDetail = {
  review: LIST.reviews[1]!,
  summary: { markdown: "# Acme tool\n\nA synthetic summary.", truncated: false, bytes: 34 },
  coverage: "coverage: unread=0",
  recommendations: null,
  topics: TOPICS,
  claims: [
    { id: "C1", source: "README.md", status: "verified", evidence: "src/a.ts:1", claim: "It caches reads", line: 2 },
    { id: "C2", source: "docs/x.md", status: "refuted", evidence: "", claim: "It streams writes", line: 3 },
  ],
  gaps: ["SUMMARY.md has no recommendations heading"],
  readAt: READ_AT,
};

function snapshotOf(detail: ReviewDetail): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: READ_AT,
    calls: {
      [snapshotKey("reviews.list", {})]: successEnvelope(LIST),
      [snapshotKey("reviews.get", { name: "acme-tool" })]: successEnvelope(detail),
    },
  };
}

function renderConsole(hash: string, detail: ReviewDetail = DETAIL): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshotOf(detail)), "text/html");
  window.location.hash = hash;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

const findingIds = (): string[] => screen.getAllByTestId(/^finding-[A-Z]/).map((row) => row.getAttribute("data-testid")!.replace("finding-", ""));

describe("the reviews list", () => {
  it("orders reviews newest first by last run, with a never-run review last", async () => {
    renderConsole("#/reviews");
    await screen.findByTestId("review-row-acme-tool");
    const rows = screen.getAllByTestId(/^review-row-/).map((row) => row.getAttribute("data-testid"));
    expect(rows).toEqual(["review-row-acme-tool", "review-row-widget-kit", "review-row-orbit-cli"]);
    expect(screen.getAllByTestId(/^review-card-/)).toHaveLength(3);
  });

  it("shows a banner naming each file that did not read", async () => {
    renderConsole("#/reviews");
    const banner = await screen.findByTestId("review-gaps");
    expect(within(banner).getByText("orbit-cli: topics-judged.tsv header lacks priority")).toBeTruthy();
  });
});

describe("a review's detail", () => {
  it("shows only P1 and P2 findings by default, priority first", async () => {
    renderConsole("#/reviews/acme-tool");
    await screen.findByTestId("finding-ACM-4");
    expect(findingIds()).toEqual(["ACM-4", "ACM-2", "ACM-1", "ACM-6"]);
    expect(screen.getByText("4 of 6 topics")).toBeTruthy();
  });

  it("reorders the findings by verdict when that sort is picked", async () => {
    renderConsole("#/reviews/acme-tool");
    await screen.findByTestId("finding-ACM-4");
    fireEvent.click(within(screen.getByTestId("findings-sort")).getByText("verdict"));
    expect(findingIds()).toEqual(["ACM-1", "ACM-4", "ACM-6", "ACM-2"]);
  });

  it("shows every priority behind the All chip", async () => {
    renderConsole("#/reviews/acme-tool");
    await screen.findByTestId("finding-ACM-4");
    fireEvent.click(within(screen.getByTestId("findings-filter")).getByText("All"));
    expect(findingIds()).toHaveLength(6);
  });

  it("shows the review's gap lines in a banner and refuted claims before verified ones", async () => {
    renderConsole("#/reviews/acme-tool");
    const banner = await screen.findByTestId("review-gaps");
    expect(within(banner).getByText("SUMMARY.md has no recommendations heading")).toBeTruthy();
    expect(screen.getByTestId("review-summary").textContent).toContain("A synthetic summary.");
    fireEvent.click(screen.getByText("Facts and claims (2)"));
    expect(screen.getAllByTestId(/^claims-/).map((group) => group.getAttribute("data-testid"))).toEqual(["claims-refuted", "claims-verified"]);
  });

  it("renders only the rows in view when a review has hundreds of findings", async () => {
    const many = Array.from({ length: 300 }, (_, index) => topic(`BIG-${index}`, "P1", "missing", index + 2));
    renderConsole("#/reviews/acme-tool", { ...DETAIL, topics: many });
    await screen.findByTestId("finding-BIG-0");
    expect(screen.getByText("300 of 300 topics")).toBeTruthy();
    expect(findingIds().length).toBeLessThan(30);
  });

  it("opens a tapped finding's reason below the list", async () => {
    renderConsole("#/reviews/acme-tool");
    fireEvent.click(await screen.findByTestId("finding-ACM-1"));
    expect(within(screen.getByTestId("finding-detail")).getByText("Why ACM-1")).toBeTruthy();
  });
});
