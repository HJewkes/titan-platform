// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { EXIT, errorEnvelope, successEnvelope } from "@titan-design/registry";
import { staticSource, snapshotKey, SNAPSHOT_FORMAT, type DataSource } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../server/commands.js";
import { listPage } from "../server/task-list.js";
import { renderPage } from "./render-page.test-helpers.js";

afterEach(cleanup);

type TasksResult = ConsoleCommands["work.tasks"]["result"];
type TimelineResult = ConsoleCommands["sessions.timeline"]["result"];

const SESSION = "0a1b2c3d-0000-4000-8000-0000000000aa";

const TASKS: TasksResult = {
  fetchedAt: "2031-03-05T00:00:00.000Z",
  evidence: { repos: ["example/orbit"], degraded: [] },
  ...listPage([{ slug: "orbit-relay", id: "OR-1", title: "Retry a dropped handshake", stage: "ready", stageReason: "No pull request found", stageGuessed: true }], {}),
};

const DEGRADED: TimelineResult = { status: "degraded", sessionId: SESSION, session: null, degraded: { reason: "graph-not-migrated", detail: "Run the migration." } };

/** Answers `command` with an error the first time and with `answer` after that; every other command is answered at once. */
function failsOnce(command: string, answer: unknown, failure = errorEnvelope("source went away", 65)): DataSource {
  const inner = staticSource({ snapshot: { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls: { [snapshotKey(command, undefined)]: successEnvelope(answer) } } });
  let calls = 0;
  return {
    call: async (name, args, options) => {
      if (name !== command) return inner.call(name, args, options);
      calls += 1;
      return calls === 1 ? failure : successEnvelope(answer);
    },
    subscribe: (handlers, options) => inner.subscribe(handlers, options),
  };
}

describe("a failed read", () => {
  it("offers Retry on the Tasks page, and pressing it renders the rows", async () => {
    renderPage(failsOnce("work.tasks", TASKS), "#/tasks");
    expect(await screen.findByText("Could not load tasks: source went away")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Retry a dropped handshake")).toBeTruthy();
  });

  it("offers Retry on the Rounds page, and pressing it renders the rows", async () => {
    const rounds = [{ id: "round-a", status: "open", updatedAt: null, valid: true, unit: "orbit-relay", round: 1, questions: 2, design: false, ship: false, recommendations: "shown" }];
    renderPage(failsOnce("rounds.list", { rounds, truncated: false, dir: "/state/rounds" }), "#/rounds");
    expect(await screen.findByText("Could not load rounds: source went away")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect((await screen.findAllByText("round-a")).length).toBeGreaterThan(0);
  });

  it("offers Retry on a session page, and pressing it renders the session", async () => {
    renderPage(failsOnce("sessions.timeline", DEGRADED), `#/sessions/${SESSION}`);
    expect(await screen.findByText(`Could not load session ${SESSION}: source went away`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/no transcript for this session is on disk/)).toBeTruthy();
  });

  it("offers no Retry for a session id that is not found", async () => {
    renderPage(failsOnce("sessions.timeline", DEGRADED, errorEnvelope("No such session", EXIT.NOINPUT)), `#/sessions/${SESSION}`);
    expect(await screen.findByText(`No session ${SESSION} in the session graph or on disk.`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
