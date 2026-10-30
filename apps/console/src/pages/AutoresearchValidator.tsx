import type { ReactNode } from "react";
import {
  Accordion,
  AccordionButton,
  AccordionItem,
  AccordionPanel,
  Alert,
  DateTime,
  EmptyState,
  Section,
  SectionContent,
  SectionHeader,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  VStack,
} from "@titan-design/react-ui";
import type { ArRunView, ArValidator } from "../../server/autoresearch-view.js";
import { shortSha } from "./autoresearch-format.js";
import { PHONE_TAP } from "./phone-tap.js";

type Look = ArValidator["looks"][number];

/** Below this the looks table scrolls sideways rather than wrap a gate list under its sha. */
const LOOKS_MIN_WIDTH = 640;

const REPORT_ONLY = "Report only. Never used for selection. Do not tune on these numbers.";

/**
 * Design §1.7: the held-out validator's looks, set apart and collapsed. This is the one section that reads
 * `run.validator`; a test injects a look and checks that no other section changes.
 */
export function AutoresearchValidator({ run }: { run: ArRunView }): ReactNode {
  const { validator } = run;
  const looks = validator === undefined ? "validator not reporting yet" : `looks ${validator.looks.length} / ${validator.maxLooks}`;
  return (
    <Section testID="autoresearch-validator">
      <SectionHeader title="Held-out validator" subtitle="Aggregate over the validator set, never per seed or per case" />
      <SectionContent>
        <VStack gap={2}>
          <Alert status="info" message={REPORT_ONLY} />
          <Accordion allowMultiple>
            <AccordionItem>
              <AccordionButton className={PHONE_TAP}>{`Validator · ${looks}`}</AccordionButton>
              <AccordionPanel>
                {validator === undefined ? <EmptyState title="validator not reporting yet" /> : <LooksTable primary={run.target.metric.primary} looks={validator.looks} />}
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        </VStack>
      </SectionContent>
    </Section>
  );
}

const gatesText = (gates: Look["aggregate"]["gates"]): string =>
  Object.entries(gates)
    .map(([name, passes]) => `${name} ${passes}`)
    .join(" · ") || "—";

function LooksTable({ primary, looks }: { primary: string; looks: readonly Look[] }): ReactNode {
  if (looks.length === 0) return <EmptyState title="The validator has not taken a look yet" />;
  return (
    <Table density="dense" contentMinWidth={LOOKS_MIN_WIDTH} testID="autoresearch-validator-looks">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Look</TableHeaderCell>
          <TableHeaderCell>When</TableHeaderCell>
          <TableHeaderCell>Ratchet sha</TableHeaderCell>
          <TableHeaderCell>{primary}</TableHeaderCell>
          <TableHeaderCell>Gates</TableHeaderCell>
          <TableHeaderCell>Provenance</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {looks.map((look) => (
          <LookRow key={look.look} primary={primary} look={look} />
        ))}
      </TableBody>
    </Table>
  );
}

function LookRow({ primary, look }: { primary: string; look: Look }): ReactNode {
  return (
    <TableRow testID={`autoresearch-validator-look-${look.look}`}>
      <TableCell>{look.look}</TableCell>
      <TableCell>
        <DateTime value={look.at} format="datetime" fallback="unknown" />
      </TableCell>
      <TableCell>{shortSha(look.sha)}</TableCell>
      <TableCell>{look.aggregate.metrics[primary] ?? "—"}</TableCell>
      <TableCell>{gatesText(look.aggregate.gates)}</TableCell>
      <TableCell>{look.provenance}</TableCell>
    </TableRow>
  );
}
