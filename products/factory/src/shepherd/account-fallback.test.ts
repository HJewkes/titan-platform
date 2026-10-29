import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchError } from "@titan-design/agent-dispatch";
import type { ReviewTarget } from "@titan-design/review-panel";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolateAgentChatHome } from "../test-support/agent-chat-home.js";
import { reviewAccounts } from "../workflows-live.js";
import { successorSpawnAccounts } from "./account-hold.js";
import { agentChatAgents } from "./agents.js";
import type { ShepherdDeps } from "./phases.js";
import { ReviewerBrokerBusy } from "./review-wait.js";
import { agentChatReviewerDispatch } from "./reviewer-dispatch.js";
import { implementersOver } from "./wake.js";

const FIRST = "/synthetic/accounts/first";
const SECOND = "/synthetic/accounts/second";
const THIRD = "/synthetic/accounts/third";
const REVIEWER = "rv-readonly";
const target: ReviewTarget = { repo: "octo/demo", pr: 7, head: "a".repeat(40) };
const ACCOUNT_LIMIT = ["Not spawned: reviewer account limit: account /synthetic/accounts/first five_hour 98% at or over ceiling 95% (no charter pool); resets Oct 29 at 8:00pm (UTC)", "code: reviewer_account_limit retryable: true"];

let dir: string;
let checkout: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tp4507-account-fallback-")));
  checkout = join(dir, "checkout");
  mkdirSync(checkout);
  isolateAgentChatHome(join(dir, "home"), [REVIEWER, "bd-implementer"]);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake `agent-chat` that logs each spawn's config dir (`default` for none) and refuses with `refusal` under `refusedDir`. */
function fakeAgentChat(refusedDir: string, refusal: readonly string[]): string {
  const bin = join(dir, "agent-chat");
  const refuse = refusal.map((line) => `echo '${line}'`).join("; ");
  const script = [
    "#!/bin/sh",
    "cat >/dev/null",
    `if [ "$2" != "spawn" ]; then printf '[]'; exit 0; fi`,
    "account=default; previous=",
    `for a in "$@"; do if [ "$previous" = "--config-dir" ]; then account="$a"; fi; previous="$a"; done`,
    `printf '%s\\n' "$account" >>"${dir}/spawns"`,
    `if [ "$account" = "${refusedDir}" ]; then ${refuse}; exit 1; fi`,
  ];
  writeFileSync(bin, `${script.join("\n")}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const spawnedUnder = (): string[] => (existsSync(join(dir, "spawns")) ? readFileSync(join(dir, "spawns"), "utf8").trim().split("\n") : []);
const warned = (): string => vi.mocked(console.warn).mock.calls.map((call) => String(call[0])).join("\n");

function reviewerAccounts(agentChatBin: string, fallbacks: readonly string[]) {
  const under = (configDir: string | undefined, fallbackConfigDirs?: () => readonly string[]) =>
    agentChatReviewerDispatch({ agentChatBin, roles: { g10: REVIEWER, standard: REVIEWER }, cwdFor: () => checkout, configDir, ...(fallbackConfigDirs && { fallbackConfigDirs }) });
  return reviewAccounts({ profile: REVIEWER, configDir: FIRST }, () => fallbacks, under, undefined).accounts;
}

const successorDeps = (rotation: readonly string[]): ShepherdDeps => partialFake<ShepherdDeps>({ successorAccounts: () => rotation });

describe("the account-limit fallback (TP-4507)", () => {
  it("a reviewer refused at the account limit spawns on the first fallback config dir", async () => {
    const accounts = reviewerAccounts(fakeAgentChat(FIRST, ACCOUNT_LIMIT), [SECOND, THIRD]);

    await accounts.dispatchUnder(FIRST).spawn("rv-demo-7", "Review octo/demo#7.", target);

    expect(spawnedUnder()).toEqual([FIRST, SECOND]);
    expect(warned()).toContain(`rv-demo-7 spawned on the fallback account ${SECOND}`);
  });

  it("a fixer successor refused at the account limit spawns on the fallback", async () => {
    const agents = implementersOver(agentChatAgents(fakeAgentChat(FIRST, ACCOUNT_LIMIT)), () => successorSpawnAccounts(successorDeps([FIRST, SECOND])));

    await agents.spawn("impl-a-s1", "Fix the parser.", checkout);

    expect(spawnedUnder()).toEqual([FIRST, SECOND]);
    expect(warned()).toContain(`impl-a-s1 spawned on the fallback account ${SECOND}`);
  });

  it("a non-account refusal does not fall back", async () => {
    const refusals = [["Not spawned: no free agent slots (4/4 in use); retire one first"], ["the name rv-demo-7 is held by a live agent; retire it or choose another"], ["Not spawned: seat budget stop", "code: seat_budget_stop retryable: true"]];
    for (const refusal of refusals) {
      rmSync(join(dir, "spawns"), { force: true });
      const accounts = reviewerAccounts(fakeAgentChat(FIRST, refusal), [SECOND]);

      const error = await accounts.dispatchUnder(FIRST).spawn("rv-demo-7", "Review octo/demo#7.", target).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(spawnedUnder()).toEqual([FIRST]);
    }
  });

  it("a spawn refused at the account limit on every account stays a busy refusal of the last one", async () => {
    const accounts = reviewerAccounts(fakeAgentChat(FIRST, ACCOUNT_LIMIT), []);

    const error = await accounts.dispatchUnder(FIRST).spawn("rv-demo-7", "Review octo/demo#7.", target).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReviewerBrokerBusy);
    expect((error as Error).cause).toBeInstanceOf(DispatchError);
    expect(spawnedUnder()).toEqual([FIRST]);
  });
});
