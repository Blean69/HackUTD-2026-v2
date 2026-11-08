import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

/** 24-px grid, round caps. 1.6 stroke at 18 px and up, 1.8 below so small icons keep their weight next to text. */
function Svg({ size = 20, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size <= 16 ? 1.8 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

// ---- actions
export const IconMic = (p: P) => <Svg {...p}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Svg>;
export const IconMicOff = (p: P) => <Svg {...p}><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10.6V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.2 5.6M19 11c0 1-.2 1.9-.6 2.8M12 18v3M4 4l16 16" /></Svg>;
export const IconPhone = (p: P) => <Svg {...p}><path d="M21 16.5v2.7a1.8 1.8 0 0 1-2 1.8 17.7 17.7 0 0 1-7.7-2.7 17.4 17.4 0 0 1-5.4-5.4A17.7 17.7 0 0 1 3.2 5a1.8 1.8 0 0 1 1.8-2h2.7a1.8 1.8 0 0 1 1.8 1.5c.1.9.4 1.8.7 2.6a1.8 1.8 0 0 1-.4 1.9L8.6 10.1a14.4 14.4 0 0 0 5.4 5.4l1.1-1.2a1.8 1.8 0 0 1 1.9-.4c.8.3 1.7.6 2.6.7A1.8 1.8 0 0 1 21 16.5z" /></Svg>;
export const IconStop = (p: P) => <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" /></Svg>;
export const IconPlay = (p: P) => <Svg {...p}><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></Svg>;
export const IconSend = (p: P) => <Svg {...p}><path d="M4 12 20 4l-4 16-4.5-6.5z" /><path d="M11.5 13.5 20 4" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
export const IconPlus = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const IconMenu = (p: P) => <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>;
export const IconChevron = (p: P) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>;
export const IconChevronDown = (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const IconArrowRight = (p: P) => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
export const IconArrowUp = (p: P) => <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>;
export const IconArrowDown = (p: P) => <Svg {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Svg>;
export const IconExternal = (p: P) => <Svg {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>;
export const IconCopy = (p: P) => <Svg {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Svg>;
export const IconInfo = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5v.01" /></Svg>;
export const IconCalendar = (p: P) => <Svg {...p}><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></Svg>;

// ---- navigation
export const IconDashboard = (p: P) => <Svg {...p}><rect x="4" y="4" width="7" height="8" rx="1.5" /><rect x="13" y="4" width="7" height="5" rx="1.5" /><rect x="13" y="11" width="7" height="9" rx="1.5" /><rect x="4" y="14" width="7" height="6" rx="1.5" /></Svg>;
export const IconPicture = (p: P) => <Svg {...p}><rect x="4" y="4" width="16" height="16" rx="2.5" /><circle cx="12" cy="12" r="3.2" /><path d="M8 4v2M16 4v2M8 18v2M16 18v2" /></Svg>;
export const IconUsers = (p: P) => <Svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3 20c.4-3.4 3-5.5 6-5.5s5.6 2.1 6 5.5" /><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.8c1.8.7 2.8 2.4 3 5.2" /></Svg>;
export const IconTable = (p: P) => <Svg {...p}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 10h16M10 10v9" /></Svg>;
export const IconBroadcast = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="1.8" fill="currentColor" /><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.4 5.4a9.4 9.4 0 0 0 0 13.2M18.6 5.4a9.4 9.4 0 0 1 0 13.2" /></Svg>;
export const IconWhatIf = (p: P) => <Svg {...p}><path d="m3 17 5.5-5.5 4 4L21 7" /><path d="M15 7h6v6" /></Svg>;
export const IconTarget = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></Svg>;
export const IconReceipt = (p: P) => <Svg {...p}><path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2z" /><path d="M9 8.5h6M9 12h6" /></Svg>;
export const IconAnalytics = (p: P) => <Svg {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>;
export const IconActivity = (p: P) => <Svg {...p}><path d="M3 12h4l2.5-6 4 12 2.5-6H21" /></Svg>;
export const IconBriefcase = (p: P) => <Svg {...p}><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18" /></Svg>;
export const IconMore = (p: P) => <Svg {...p}><circle cx="5.5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="18.5" cy="12" r="1.4" fill="currentColor" /></Svg>;

// ---- domain
export const IconHome = (p: P) => <Svg {...p}><path d="M4 11 12 4l8 7v8.5a.5.5 0 0 1-.5.5H15v-5.5H9V20H4.5a.5.5 0 0 1-.5-.5z" /></Svg>;
export const IconCar = (p: P) => <Svg {...p}><path d="M5 16.5V13l1.8-4.6A1.5 1.5 0 0 1 8.2 7.5h7.6a1.5 1.5 0 0 1 1.4.9L19 13v3.5" /><path d="M4 13h16v3.5a.5.5 0 0 1-.5.5H4.5a.5.5 0 0 1-.5-.5z" /><circle cx="8" cy="17.5" r="1.5" /><circle cx="16" cy="17.5" r="1.5" /></Svg>;
export const IconWallet = (p: P) => <Svg {...p}><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><rect x="4" y="8" width="16" height="11" rx="2" /><path d="M16 13.5h.01" /></Svg>;
export const IconPiggy = (p: P) => <Svg {...p}><path d="M19 11.5c0-3.3-3.1-5.5-7-5.5S5 8.2 5 11.5c0 1.9 1 3.5 2.5 4.5V19h2.5v-2h4v2h2.5v-3c.8-.5 1.4-1.2 1.8-2H20v-3h-1.2z" /><path d="M9.5 5.5 11 3l1 3M15 10.5v.01" /></Svg>;
export const IconCard =(p: P) => <Svg {...p}><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h3" /></Svg>;
export const IconBank = (p: P) => <Svg {...p}><path d="M3 9.5 12 4l9 5.5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" /></Svg>;
export const IconCap = (p: P) => <Svg {...p}><path d="m2.5 9.5 9.5-5 9.5 5-9.5 5z" /><path d="M6.5 12v4.5c1.5 1.5 3.4 2 5.5 2s4-.5 5.5-2V12M21.5 9.5V15" /></Svg>;
export const IconShield = (p: P) => <Svg {...p}><path d="M12 3 4.5 6v5.5c0 4.5 3 8 7.5 9.5 4.5-1.5 7.5-5 7.5-9.5V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></Svg>;
export const IconRepeat = (p: P) => <Svg {...p}><path d="M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3" /></Svg>;
export const IconFile = (p: P) => <Svg {...p}><path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z" /><path d="M14 3.5V8h4M9 12.5h6M9 16h6" /></Svg>;
export const IconLandmark = (p: P) => <Svg {...p}><path d="M3 20h18M5 20V11M19 20V11M9 20V11M15 20V11M2.5 9 12 4l9.5 5z" /></Svg>;
export const IconPlane = (p: P) => <Svg {...p}><path d="M10.5 13.5 3 11l1-1.5 8 .5 4-5.5a1.6 1.6 0 0 1 2.7 1.7L15 13l.5 8-1.5 1-2.5-7.5-5 2.5z" /></Svg>;
export const IconTag = (p: P) => <Svg {...p}><path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z" /><circle cx="8" cy="8" r="1.4" /></Svg>;
export const IconAlert = (p: P) => <Svg {...p}><path d="M12 3 2.5 20h19z" /><path d="M12 10v4.5M12 17.5v.01" /></Svg>;
export const IconBell = (p: P) => <Svg {...p}><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4" /></Svg>;
export const IconSpark = (p: P) => <Svg {...p}><path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" /><path d="M18.5 16.5v3M17 18h3" /></Svg>;
export const IconBot = (p: P) => <Svg {...p}><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 8V4.5M9 13.5v.01M15 13.5v.01M9.5 16.5h5" /><circle cx="12" cy="3.5" r="1" /></Svg>;
export const IconChat = (p: P) => <Svg {...p}><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" /></Svg>;
export const IconWrench = (p: P) => <Svg {...p}><path d="M14.5 6.5a4 4 0 0 0 5 5L10 21a2.1 2.1 0 0 1-3-3z" /><path d="m14.5 6.5 3-3" /></Svg>;
export const IconBolt = (p: P) => <Svg {...p}><path d="M13 3 5 13.5h6L10 21l9-11h-6z" /></Svg>;
export const IconKey = (p: P) => <Svg {...p}><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M16 7l3 3M14 9l2 2" /></Svg>;
export const IconLock = (p: P) => <Svg {...p}><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></Svg>;
export const IconTrend = (p: P) => <Svg {...p}><path d="m3 17 6-6 4 4 8-8M15 7h6v6" /></Svg>;
export const IconChart = (p: P) => <Svg {...p}><path d="M4 19V5M4 19h16M8 15l3.5-4 3 2.5L20 7" /></Svg>;
export const IconVote = (p: P) => <Svg {...p}><rect x="4" y="12" width="16" height="8" rx="1.5" /><path d="M8 12V6.5L12 4l4 2.5V12M10 8.5h4" /></Svg>;
export const IconThumb = (p: P) => <Svg {...p}><path d="M7 11v9H4.5a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5zM7 11l4-7c1.7 0 2.5 1.2 2.2 2.8L12.7 9H19a1.5 1.5 0 0 1 1.5 1.8l-1.3 7A2 2 0 0 1 17.2 19.5H7" /></Svg>;

// ---- theme
export const IconSun = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="3.6" /><path d="M12 3.5v1.8M12 18.7v1.8M3.5 12h1.8M18.7 12h1.8M6 6l1.3 1.3M16.7 16.7 18 18M6 18l1.3-1.3M16.7 7.3 18 6" /></Svg>;
export const IconMoon = (p: P) => <Svg {...p}><path d="M19.5 14.2A7.8 7.8 0 0 1 9.8 4.5a7.8 7.8 0 1 0 9.7 9.7z" /></Svg>;
export const IconMonitor = (p: P) => <Svg {...p}><rect x="3.5" y="4.5" width="17" height="11.5" rx="2" /><path d="M9 20h6M12 16v4" /></Svg>;
export const IconGauge = (p: P) => <Svg {...p}><path d="M4.2 16.5a8.5 8.5 0 1 1 15.6 0" /><path d="m12 13.5 4-4.5" /><circle cx="12" cy="14" r="1.3" fill="currentColor" /></Svg>;
export const IconSearch = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.4-4.4" /></Svg>;

/** The Cosign mark: a check made of two separate strokes, two people signing off together. Accent tile, white strokes. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path d="M8.6 16.8 12.6 20.8" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <path d="M16.4 19.4 23.6 11.2" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
