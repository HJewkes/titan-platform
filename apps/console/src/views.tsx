import type { ReactNode } from "react";
import {
  ActivityIcon,
  AwardIcon,
  BotIcon,
  BrainIcon,
  EqualIcon,
  HistoryIcon,
  KanbanIcon,
  LayersIcon,
  TargetIcon,
  type SideNavItem,
} from "@titan-design/react-ui";
import type { ViewKey } from "./router.js";

export interface ViewSpec {
  key: ViewKey;
  /** The rail's micro-label; it sits under a 20px glyph, so it stays short. */
  label: string;
  title: string;
  icon: ReactNode;
  /** What the view will show, and the tasks that build it; absent for a view that already exists. */
  planned?: { summary: string; tasks: string };
}

const ICON_SIZE = 20;

/** The planned views in rail order. Search, Stores and Flow borrow the nearest glyph until react-ui has one. */
export const VIEWS: readonly ViewSpec[] = [
  { key: "status", label: "Status", title: "Status", icon: <ActivityIcon size={ICON_SIZE} /> },
  { key: "initiatives", label: "Work", title: "Initiatives", icon: <LayersIcon size={ICON_SIZE} /> },
  {
    key: "tasks", label: "Tasks", title: "Tasks", icon: <KanbanIcon size={ICON_SIZE} />,
    planned: { summary: "A read-only board with derived columns, and task detail with its dependency tree.", tasks: "TP-866" },
  },
  {
    key: "sessions", label: "Sessions", title: "Sessions", icon: <HistoryIcon size={ICON_SIZE} />,
    planned: { summary: "The sessions list, the conversation reader, the time-synced sidebar and replay.", tasks: "TP-862 and TP-863" },
  },
  {
    key: "agents", label: "Agents", title: "Agents", icon: <BotIcon size={ICON_SIZE} />,
    planned: { summary: "The agent roster with costs, the agent topology and agent-to-agent chat.", tasks: "TP-864 and TP-865" },
  },
  {
    key: "productivity", label: "Flow", title: "Productivity and quality", icon: <AwardIcon size={ICON_SIZE} />,
    planned: { summary: "Throughput, lead time, work-in-progress age and fix-proof verdicts.", tasks: "TP-867" },
  },
  {
    key: "knowledge", label: "Notes", title: "Knowledge", icon: <BrainIcon size={ICON_SIZE} />,
    planned: { summary: "Notes and sources across initiatives, then the knowledge graph and retrieval explorer.", tasks: "TP-869 and TP-871" },
  },
  {
    key: "search", label: "Search", title: "Search", icon: <TargetIcon size={ICON_SIZE} />,
    planned: { summary: "Search across six record classes, and an inventory of what is stored where.", tasks: "TP-870" },
  },
  {
    key: "stores", label: "Stores", title: "Stores", icon: <EqualIcon size={ICON_SIZE} />,
    planned: { summary: "Every database and file root, with its size and row counts.", tasks: "TP-872" },
  },
];

export const NAV_ITEMS: SideNavItem[] = VIEWS.map(({ key, label, icon }) => ({ key, label, icon }));

export function viewFor(key: ViewKey): ViewSpec {
  return VIEWS.find((view) => view.key === key) ?? VIEWS[0]!;
}
