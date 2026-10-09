import type { ReactNode } from "react";
import { ActivityIcon, BotIcon, BrainIcon, HistoryIcon, KanbanIcon, LayersIcon, type SideNavItem } from "@titan-design/react-ui";
import { VIEW_KEYS, type ViewKey } from "./router.js";

export interface ViewSpec {
  key: ViewKey;
  /** The rail's micro-label; it sits under a 20px glyph, so it stays short. */
  label: string;
  title: string;
  icon: ReactNode;
  /** What the view will show, and the tasks that build it; the placeholder says so until a page is registered. */
  planned?: { summary: string; tasks: string };
}

const ICON_SIZE = 20;

/** The rail of six. Home borrows the activity glyph because react-ui exports no home icon. */
const SPECS: Record<ViewKey, Omit<ViewSpec, "key">> = {
  home: { label: "Home", title: "Home", icon: <ActivityIcon size={ICON_SIZE} /> },
  initiatives: { label: "Work", title: "Initiatives", icon: <LayersIcon size={ICON_SIZE} /> },
  tasks: {
    label: "Tasks", title: "Tasks", icon: <KanbanIcon size={ICON_SIZE} />,
    planned: { summary: "Tasks across initiatives grouped by derived stage, and task detail.", tasks: "TP-866a" },
  },
  sessions: {
    label: "Sessions", title: "Sessions", icon: <HistoryIcon size={ICON_SIZE} />,
    planned: { summary: "The sessions list, and one session with its conversation first.", tasks: "TP-862" },
  },
  agents: {
    label: "Agents", title: "Agents", icon: <BotIcon size={ICON_SIZE} />,
    planned: { summary: "The agent roster, spawn tree and message feed, and one agent's runs and messages.", tasks: "TP-864a and TP-865a" },
  },
  knowledge: { label: "Notes", title: "Knowledge", icon: <BrainIcon size={ICON_SIZE} /> },
};

export const VIEWS: readonly ViewSpec[] = VIEW_KEYS.map((key) => ({ key, ...SPECS[key] }));

export const NAV_ITEMS: SideNavItem[] = VIEWS.map(({ key, label, icon }) => ({ key, label, icon }));

export function viewFor(key: ViewKey): ViewSpec {
  return VIEWS.find((view) => view.key === key) ?? VIEWS[0]!;
}
