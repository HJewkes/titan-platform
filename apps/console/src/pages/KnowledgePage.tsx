import { useState, type ReactNode } from "react";
import { Alert, Button, ButtonText, EmptyState, HStack, Input, Select, Spinner, Tab, TabList, Tabs, VStack, type SelectOption } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open, type Route } from "../router.js";
import { KnowledgeGraph } from "./KnowledgeGraph.js";
import { KnowledgeRecordPage } from "./KnowledgeRecordPage.js";
import { KnowledgeSearch } from "./KnowledgeSearch.js";
import { KnowledgeTable } from "./KnowledgeTable.js";
import { PHONE_TAP, usePhoneInputSize } from "./phone.js";

type KnowledgeRow = ConsoleCommands["work.notes"]["result"]["records"][number];

const TABS = ["browse", "search", "graph"] as const;
type FilterKey = "initiative" | "kind" | "since";
const KIND_OPTIONS: SelectOption[] = [
  { value: "note", label: "Notes only" },
  { value: "source", label: "Sources only" },
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `#/knowledge` lists, searches and graphs `?ref=`; `#/knowledge/<ref>` reads one record or graphs it. */
export function KnowledgePage({ route }: { route: Route }): ReactNode {
  const params = new URLSearchParams(route.query);
  if (route.id) return <KnowledgeRecordPage recordRef={route.id} graph={params.get("tab") === "graph"} />;
  const tab = Math.max(0, TABS.findIndex((name) => name === params.get("tab")));
  return (
    <VStack gap={4}>
      <Tabs index={tab} onChange={(index) => open({ view: "knowledge", ...(index === 0 ? {} : { query: `tab=${TABS[index]}` }) })}>
        <TabList>
          <Tab className={PHONE_TAP}>Browse</Tab>
          <Tab className={PHONE_TAP}>Search</Tab>
          <Tab className={PHONE_TAP}>Graph</Tab>
        </TabList>
      </Tabs>
      <TabBody tab={TABS[tab]!} params={params} />
    </VStack>
  );
}

function TabBody({ tab, params }: { tab: (typeof TABS)[number]; params: URLSearchParams }): ReactNode {
  if (tab === "search") return <KnowledgeSearch key={params.get("q") ?? ""} q={params.get("q") ?? ""} />;
  if (tab === "graph") return <KnowledgeGraph center={params.get("ref")} />;
  return <Browse params={params} />;
}

/** Every filter lives in the query string, so a filtered list is a link. */
function setFilter(params: URLSearchParams, key: FilterKey, value: string | null): void {
  const next = new URLSearchParams(params);
  if (value) next.set(key, value);
  else next.delete(key);
  const query = next.toString();
  open({ view: "knowledge", ...(query ? { query } : {}) });
}

function matches(record: KnowledgeRow, params: URLSearchParams): boolean {
  const initiative = params.get("initiative");
  const kind = params.get("kind");
  const since = params.get("since");
  return (!initiative || record.slug === initiative) && (!kind || record.kind === kind) && (!since || (record.changed ?? "") >= since);
}

function Browse({ params }: { params: URLSearchParams }): ReactNode {
  const notes = useQuery("work.notes");
  if (notes.status === "loading") return <Spinner size="sm" label="Loading notes and sources" />;
  if (notes.data === undefined) return <Alert status="error" message={`Could not load notes: ${notes.error.message}`} />;
  const { records } = notes.data;
  if (records.length === 0) return <EmptyState title="No notes or sources" description="No initiative has a note or source file." />;
  const shown = records.filter((record) => matches(record, params));
  return (
    <VStack gap={4}>
      <Filters params={params} slugs={[...new Set(records.map((record) => record.slug))].sort()} />
      {shown.length > 0 ? (
        <KnowledgeTable records={shown} />
      ) : (
        <EmptyState title="No notes or sources match these filters" action={<Button onPress={() => open({ view: "knowledge" })}><ButtonText>Clear filters</ButtonText></Button>} />
      )}
    </VStack>
  );
}

function Filters({ params, slugs }: { params: URLSearchParams; slugs: readonly string[] }): ReactNode {
  return (
    <HStack gap={3} align="center" wrap>
      <Select
        placeholder="Any initiative"
        value={params.get("initiative")}
        options={slugs.map((slug) => ({ value: slug, label: slug }))}
        onChange={(value) => setFilter(params, "initiative", value)}
        className="w-56"
      />
      <Select placeholder="Notes and sources" value={params.get("kind")} options={KIND_OPTIONS} onChange={(value) => setFilter(params, "kind", value)} className="w-48" />
      <SinceInput key={params.get("since") ?? ""} params={params} />
    </HStack>
  );
}

/** Commits only a whole date, or a cleared field, so a half-typed date never empties the list. */
function SinceInput({ params }: { params: URLSearchParams }): ReactNode {
  const [draft, setDraft] = useState(params.get("since") ?? "");
  const change = (text: string): void => {
    setDraft(text);
    if (text === "" || DATE.test(text)) setFilter(params, "since", text || null);
  };
  return <Input value={draft} onChangeText={change} placeholder="Changed since YYYY-MM-DD" accessibilityLabel="Changed since" size={usePhoneInputSize()} className="w-56" />;
}
