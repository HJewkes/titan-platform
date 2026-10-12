import type { GateRecord } from "@titan-design/hitl";
import type { SeatBook } from "../shepherd/seats.js";

/** A standing grant and the gates resolved under it; grants never expire (owner declined Q3), so there is no expiry field. */
export interface StandingGrant {
  grant: string;
  /** `seat:<name>` for a seat's `grants_extra`, `delegate` for a grant only a delegate's resolve names. */
  source: string;
  resolved: number;
  gateIds: string[];
}

/** The grant a resolve was made under, as S1 records it on the gate's evidence. */
export function grantOf(gate: GateRecord): string | undefined {
  const grant = gate.status === "resolved" ? gate.resolvedEvidence?.grant : undefined;
  return typeof grant === "string" && grant.length > 0 ? grant : undefined;
}

function row(grant: string, source: string, gates: readonly GateRecord[]): StandingGrant {
  const gateIds = gates.filter((gate) => grantOf(gate) === grant).map((gate) => gate.id);
  return { grant, source, resolved: gateIds.length, gateIds };
}

/** Every seat grant, then every grant a resolve in `gates` names that no seat holds, each with the gates resolved under it. */
export function standingGrants(book: SeatBook, gates: readonly GateRecord[]): StandingGrant[] {
  const seatRows = book.seats.flatMap((seat) => seat.grants.map((grant) => row(grant, `seat:${seat.name}`, gates)));
  const seatGrants = new Set(seatRows.map((seatRow) => seatRow.grant));
  const delegateGrants = [...new Set(gates.map(grantOf).filter((grant): grant is string => grant !== undefined && !seatGrants.has(grant)))].sort();
  return [...seatRows, ...delegateGrants.map((grant) => row(grant, "delegate", gates))];
}
