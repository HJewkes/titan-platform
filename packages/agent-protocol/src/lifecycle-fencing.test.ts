import { describe, expect, it } from "vitest";
import { reduceExecutionTransition, type ExecutionOwnerLease, type ExecutionRecord, type ExecutionTransition } from "./index.js";
import { LEASE, T1, T2, T3, apply, event, expectCode, fence, prepare } from "./test-fixtures.js";

const leaseA1: ExecutionOwnerLease = { supervisorId: "supervisor-a", generation: 1, leaseUntil: LEASE };
const leaseA2: ExecutionOwnerLease = { ...leaseA1, generation: 2 };
const fenceOf = ({ supervisorId, generation }: ExecutionOwnerLease) => ({ supervisorId, generation });

function under(lease: ExecutionOwnerLease, current: ExecutionRecord<string> | undefined, transition: ExecutionTransition<string>) {
  return reduceExecutionTransition(current, transition, { fencing: { kind: "supervisor", lease } });
}

function preparedUnder(lease: ExecutionOwnerLease): ExecutionRecord<string> {
  return under(lease, undefined, prepare({ owner: { ...lease } }));
}

const dispatch = (lease: ExecutionOwnerLease, fence = fenceOf(lease)) => event("begin_dispatch", 1, T1, { fence });

describe("supervisor fencing", () => {
  it("refuses a fence from an older generation than the lease", () => {
    expectCode(() => under(leaseA2, preparedUnder(leaseA1), dispatch(leaseA2, fenceOf(leaseA1))), "ownership_lost");
  });

  it("refuses a row owned by another supervisor", () => {
    const leaseB: ExecutionOwnerLease = { ...leaseA1, supervisorId: "supervisor-b" };

    expectCode(() => under(leaseA1, preparedUnder(leaseB), dispatch(leaseA1)), "ownership_lost");
  });

  it("refuses an expired supervisor lease even while the row's own lease is live", () => {
    const expired: ExecutionOwnerLease = { ...leaseA1, leaseUntil: T2 };
    const record = preparedUnder(leaseA1);

    expect(record.owner?.leaseUntil).toBe(LEASE);
    expectCode(() => under(expired, record, event("begin_dispatch", 1, T3, { fence: fenceOf(expired) })), "ownership_lost");
  });

  it("adopts a generation-1 row into a generation-2 lease on its next write", () => {
    const record = under(leaseA2, preparedUnder(leaseA1), dispatch(leaseA2));

    expect(record).toMatchObject({ phase: "dispatching", ownerGeneration: 2, owner: leaseA2 });
  });

  it("refuses a lease older than the generation that last wrote the row", () => {
    const adopted = under(leaseA2, preparedUnder(leaseA1), dispatch(leaseA2));

    expectCode(() => under(leaseA1, adopted, event("request_cancellation", 2, T2, { fence: fenceOf(leaseA1), reason: "stop" })), "ownership_lost");
  });

  it.each([
    ["claim_owner", event("claim_owner", 1, T1, { owner: leaseA2 })],
    ["renew_owner", event("renew_owner", 1, T1, { fence: fenceOf(leaseA1), leaseUntil: "2026-09-11T14:00:00.000Z" })],
    ["release_owner", event("release_owner", 1, T1, { fence: fenceOf(leaseA1) })],
  ])("refuses %s because the lease lives on the supervisor row", (_, transition) => {
    expectCode(() => under(leaseA1, preparedUnder(leaseA1), transition), "invalid_transition");
  });

  it("prepares under any lease generation but only with the lease as owner", () => {
    expect(preparedUnder(leaseA2)).toMatchObject({ ownerGeneration: 2, owner: leaseA2 });
    expectCode(() => under(leaseA2, undefined, prepare({ owner: { ...leaseA1 } })), "ownership_lost");
  });
});

describe("default execution fencing", () => {
  it("still fences by the row's own lease when no option is passed", () => {
    const record = apply(undefined, prepare({ owner: { ...fence, leaseUntil: T2 } }));

    expectCode(() => apply(record, event("begin_dispatch", 1, T3, { fence })), "ownership_lost");
    expect(apply(record, event("begin_dispatch", 1, T1, { fence })).ownerGeneration).toBe(1);
  });
});
