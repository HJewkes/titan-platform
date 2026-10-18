import type { ReactNode } from "react";
import { ActivityIcon, AlertTriangleIcon, BotIcon, BrainIcon, HeadphonesIcon, HistoryIcon, KanbanIcon, LayersIcon, ScaleIcon, TargetIcon, type SideNavItem } from "@titan-design/react-ui";
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

/** The rail. Home borrows the activity glyph, Inbox the alert glyph, Rounds the target glyph, Theater the headphones glyph and Shepherd the scale glyph, because react-ui exports no home, inbox or play icon. */
const SPECS: Record<ViewKey, Omit<ViewSpec, "key">> = {
  home: { label: "Home", title: "Home", icon: <ActivityIcon size={ICON_SIZE} /> },
  inbox: { label: "Inbox", title: "Inbox", icon: <AlertTriangleIcon size={ICON_SIZE} /> },
  initiatives: { label: "Work", title: "Initiatives", icon: <LayersIcon size={ICON_SIZE} /> },
  tasks: { label: "Tasks", title: "Tasks", icon: <KanbanIcon size={ICON_SIZE} /> },
  sessions: { label: "Sessions", title: "Sessions", icon: <HistoryIcon size={ICON_SIZE} /> },
  agents: { label: "Agents", title: "Agents", icon: <BotIcon size={ICON_SIZE} /> },
  knowledge: { label: "Notes", title: "Knowledge", icon: <BrainIcon size={ICON_SIZE} /> },
  rounds: { label: "Rounds", title: "Review rounds", icon: <TargetIcon size={ICON_SIZE} /> },
  theater: { label: "Theater", title: "Theater", icon: <HeadphonesIcon size={ICON_SIZE} /> },
  shepherd: { label: "Shepherd", title: "Shepherd", icon: <ScaleIcon size={ICON_SIZE} /> },
};

export const VIEWS: readonly ViewSpec[] = VIEW_KEYS.map((key) => ({ key, ...SPECS[key] }));

export const NAV_ITEMS: SideNavItem[] = VIEWS.map(({ key, label, icon }) => ({ key, label, icon }));

export function viewFor(key: ViewKey): ViewSpec {
  return VIEWS.find((view) => view.key === key) ?? VIEWS[0]!;
}
