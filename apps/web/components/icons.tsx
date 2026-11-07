import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const IconMic = (p: P) => <Svg {...p}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Svg>;
export const IconStop = (p: P) => <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" /></Svg>;
export const IconPlay = (p: P) => <Svg {...p}><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></Svg>;
export const IconSend = (p: P) => <Svg {...p}><path d="M4 12 20 4l-4 16-4.5-6.5z" /><path d="M11.5 13.5 20 4" /></Svg>;
export const IconSun = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>;
export const IconMoon = (p: P) => <Svg {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
export const IconChevron = (p: P) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>;
export const IconChevronDown = (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const IconAlert = (p: P) => <Svg {...p}><path d="M12 3 2.5 20h19z" /><path d="M12 10v4.5M12 17.5v.01" /></Svg>;
export const IconShield = (p: P) => <Svg {...p}><path d="M12 3 4.5 6v5.5c0 4.5 3 8 7.5 9.5 4.5-1.5 7.5-5 7.5-9.5V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></Svg>;
export const IconSpark = (p: P) => <Svg {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></Svg>;
export const IconUsers = (p: P) => <Svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3 20c.4-3.4 3-5.5 6-5.5s5.6 2.1 6 5.5" /><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.8c1.8.7 2.8 2.4 3 5.2" /></Svg>;
export const IconHome = (p: P) => <Svg {...p}><path d="M4 11 12 4l8 7v8.5a.5.5 0 0 1-.5.5H15v-5.5H9V20H4.5a.5.5 0 0 1-.5-.5z" /></Svg>;
export const IconChart = (p: P) => <Svg {...p}><path d="M4 19V5M4 19h16M8 15l3.5-4 3 2.5L20 7" /></Svg>;
export const IconBot = (p: P) => <Svg {...p}><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 8V4.5M9 13.5v.01M15 13.5v.01M9.5 16.5h5" /><circle cx="12" cy="3.5" r="1" /></Svg>;
export const IconChat = (p: P) => <Svg {...p}><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" /></Svg>;
export const IconBriefcase = (p: P) => <Svg {...p}><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18" /></Svg>;
export const IconWrench = (p: P) => <Svg {...p}><path d="M14.5 6.5a4 4 0 0 0 5 5L10 21a2.1 2.1 0 0 1-3-3z" /><path d="m14.5 6.5 3-3" /></Svg>;
export const IconBolt = (p: P) => <Svg {...p}><path d="M13 3 5 13.5h6L10 21l9-11h-6z" /></Svg>;
export const IconKey = (p: P) => <Svg {...p}><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M16 7l3 3M14 9l2 2" /></Svg>;
export const IconLock = (p: P) => <Svg {...p}><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></Svg>;
export const IconBell = (p: P) => <Svg {...p}><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4" /></Svg>;
export const IconTrend = (p: P) => <Svg {...p}><path d="m3 17 6-6 4 4 8-8M15 7h6v6" /></Svg>;
export const IconCopy = (p: P) => <Svg {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Svg>;

export function KeystoneMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M5 6.5C5 5.7 5.7 5 6.5 5h19c.8 0 1.5.7 1.5 1.5 0 .3-.1.6-.2.8L22 26.2c-.2.5-.7.8-1.2.8H11.2c-.5 0-1-.3-1.2-.8L5.2 7.3c-.1-.2-.2-.5-.2-.8z" fill="currentColor" />
      <circle cx="16" cy="13" r="2.6" fill="var(--brand-ink)" />
      <path d="M14.6 14.5h2.8l1.1 6h-5z" fill="var(--brand-ink)" />
    </svg>
  );
}
