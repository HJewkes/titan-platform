import type { ReactNode } from "react";
import { Button, ButtonText, DateTime, HStack, Typography, VStack } from "@titan-design/react-ui";
import { useQuery } from "../data/rpc.js";
import { replace } from "../router.js";
import { CoordinatorCards } from "./CoordinatorCards.js";
import { CoordinatorPools } from "./CoordinatorPools.js";
import { PHONE_TAP } from "./phone.js";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The day the query names; a malformed one is dropped so the page shows today rather than an error. */
function dateFrom(query: string | undefined): string | undefined {
  const date = new URLSearchParams(query ?? "").get("date");
  return date !== null && CALENDAR_DATE.test(date) ? date : undefined;
}

/** Calendar arithmetic only, in UTC, so a daylight-saving change never skips or repeats a day. */
function shiftDate(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

const showDay = (date: string | undefined): void => replace({ view: "coordinator", ...(date === undefined ? {} : { query: `date=${date}` }) });

/** The coordinator day: pool meters, then one card per coordinator. A day runs from the configured start, 07:00 local by default. */
export function CoordinatorPage({ query }: { query?: string }): ReactNode {
  const date = dateFrom(query);
  const day = date === undefined ? {} : { date };
  return (
    <VStack gap={6}>
      <DayPicker date={date} day={day} />
      <CoordinatorPools day={day} />
      <CoordinatorCards day={day} />
    </VStack>
  );
}

/** The shown day comes from the pools answer, since only the server knows which day "today" is at its day start. */
function DayPicker({ date, day }: { date: string | undefined; day: { date?: string } }): ReactNode {
  const pools = useQuery("coord.pools", day);
  const shown = date ?? pools.data?.date;
  return (
    <HStack gap={2} align="center" className="flex-wrap" testID="coord-day">
      <Button size="sm" variant="outline" className={PHONE_TAP} isDisabled={shown === undefined} onPress={() => shown !== undefined && showDay(shiftDate(shown, -1))} testID="coord-day-previous">
        <ButtonText>Previous day</ButtonText>
      </Button>
      <Typography variant="subtitle2" testID="coord-day-label">
        {shown ?? "Today"}
      </Typography>
      <Button size="sm" variant="outline" className={PHONE_TAP} isDisabled={date === undefined} onPress={() => date !== undefined && showDay(shiftDate(date, 1))} testID="coord-day-next">
        <ButtonText>Next day</ButtonText>
      </Button>
      <Button size="sm" variant="ghost" className={PHONE_TAP} isDisabled={date === undefined} onPress={() => showDay(undefined)} testID="coord-day-today">
        <ButtonText>Today</ButtonText>
      </Button>
      {pools.data === undefined ? null : (
        <Typography variant="caption" color="secondary" testID="coord-day-window">
          {"From "}
          <DateTime value={pools.data.from} format="datetime" />
          {" to "}
          <DateTime value={pools.data.to} format="datetime" />
        </Typography>
      )}
    </HStack>
  );
}
