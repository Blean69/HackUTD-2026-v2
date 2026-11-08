import type { ComponentType } from "react";
import { IconActivity, IconAnalytics, IconCap, IconDashboard, IconGauge, IconPicture, IconTable, IconTarget, IconUsers, IconWhatIf } from "@/components/icons";

export interface NavItem {
  key: string;
  label: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
  href: (householdId: string) => string;
  /** True when `path` belongs to this item. */
  match: (path: string, householdId: string) => boolean;
  live?: boolean;
}

const room = (sub: string) => (id: string) => `/room/${id}${sub}`;
const under = (sub: string) => (path: string, id: string) => path === `/room/${id}${sub}` || path.startsWith(`/room/${id}${sub}/`);

export const NAV: NavItem[] = [
  { key: "dashboard", label: "Dashboard", Icon: IconDashboard, href: room(""), match: (p, id) => p === `/room/${id}` || p === `/room/${id}/` },
  { key: "picture", label: "My Picture", Icon: IconPicture, href: room("/picture"), match: under("/picture") },
  { key: "analytics", label: "Analytics", Icon: IconAnalytics, href: room("/analytics"), match: under("/analytics") },
  { key: "credit", label: "Credit", Icon: IconGauge, href: room("/credit"), match: under("/credit") },
  { key: "household", label: "Household", Icon: IconUsers, href: room("/household"), match: under("/household") },
  { key: "table", label: "Table Mode", Icon: IconTable, href: room("/table"), match: under("/table"), live: true },
  { key: "what-if", label: "What-If Studio", Icon: IconWhatIf, href: room("/what-if"), match: under("/what-if") },
  { key: "goals", label: "Goals", Icon: IconTarget, href: room("/goals"), match: under("/goals") },
  { key: "kids", label: "Kids & Teens", Icon: IconCap, href: room("/kids"), match: under("/kids") },
  { key: "agents", label: "Agent Trail", Icon: IconActivity, href: () => "/agents", match: (p) => p.startsWith("/agents") },
];

/** Sidebar and phone drawer: three short groups instead of one long list. */
export const NAV_GROUPS: { label?: string; keys: string[] }[] = [
  { keys: ["dashboard", "picture", "analytics", "credit", "household"] },
  { label: "Plan together", keys: ["table", "what-if", "goals", "kids"] },
  { label: "Under the hood", keys: ["agents"] },
];

/** Bottom tab bar on phones (the Talk button sits in the middle). */
export const TABS: { key: string; label: string }[] = [
  { key: "dashboard", label: "Home" },
  { key: "table", label: "Table" },
  { key: "what-if", label: "What-If" },
  { key: "goals", label: "Goals" },
];
