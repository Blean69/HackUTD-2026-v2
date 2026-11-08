import type { ComponentType } from "react";
import { IconActivity, IconBriefcase, IconDashboard, IconPicture, IconTable, IconTarget, IconUsers, IconWhatIf } from "@/components/icons";

export interface NavItem {
  key: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
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
  { key: "household", label: "Household", Icon: IconUsers, href: room("/household"), match: under("/household") },
  { key: "table", label: "Table Mode", Icon: IconTable, href: room("/table"), match: under("/table"), live: true },
  { key: "what-if", label: "What-If Studio", Icon: IconWhatIf, href: room("/what-if"), match: under("/what-if") },
  { key: "goals", label: "Goals", Icon: IconTarget, href: room("/goals"), match: under("/goals") },
  { key: "agents", label: "Agent Trail", Icon: IconActivity, href: () => "/agents", match: (p) => p.startsWith("/agents") },
  { key: "advisor", label: "Advisor Console", Icon: IconBriefcase, href: () => "/advisor", match: (p) => p.startsWith("/advisor") },
];

/** Sidebar and phone drawer: three short groups instead of one long list. */
export const NAV_GROUPS: { label?: string; keys: string[] }[] = [
  { keys: ["dashboard", "picture", "household"] },
  { label: "Plan together", keys: ["table", "what-if", "goals"] },
  { label: "Under the hood", keys: ["agents", "advisor"] },
];

/** Bottom tab bar on phones (the Talk button sits in the middle). */
export const TABS: { key: string; label: string }[] = [
  { key: "dashboard", label: "Home" },
  { key: "table", label: "Table" },
  { key: "what-if", label: "What-If" },
  { key: "goals", label: "Goals" },
];
