const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdFmtCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export function usd(n: number, opts?: { cents?: boolean; compact?: boolean; sign?: boolean }): string {
  if (!Number.isFinite(n)) return "—";
  if (opts?.compact) {
    const abs = Math.abs(n);
    const s = abs >= 1_000_000 ? `${trim(abs / 1_000_000)}M` : abs >= 10_000 ? `${Math.round(abs / 1000)}k` : abs >= 1000 ? `${trim(abs / 1000)}k` : `${Math.round(abs)}`;
    return `${n < 0 ? "-" : opts.sign && n > 0 ? "+" : ""}$${s}`;
  }
  const s = (opts?.cents ? usdFmtCents : usdFmt).format(Math.abs(n));
  return `${n < 0 ? "-" : opts?.sign && n > 0 ? "+" : ""}${s}`;
}

function trim(x: number): string {
  return x.toFixed(1).replace(/\.0$/, "");
}

export function pct(n: number, digits = 0): string {
  return `${n.toFixed(digits)}%`;
}

export function months(n: number): string {
  return `${n.toFixed(1)} mo`;
}

export function metric(value: number, unit: "usd" | "pct" | "months"): string {
  return unit === "usd" ? usd(value) : unit === "pct" ? pct(value, 1) : months(value);
}

export function shortDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function longDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length > 1 && /^\d/.test(parts[parts.length - 1])) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Stable pseudo-random hue for a name, so a person keeps their colour on every phone. */
export function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export const ACCOUNT_GROUPS: { key: string; label: string; types: string[]; liability?: boolean }[] = [
  { key: "checking", label: "Checking", types: ["checking"] },
  { key: "savings", label: "Savings", types: ["savings"] },
  { key: "cd_ira", label: "CDs & IRAs", types: ["cd", "ira"] },
  { key: "loans", label: "Loans", types: ["auto_loan", "personal_loan"], liability: true },
  { key: "cards", label: "Credit cards", types: ["credit_card"], liability: true },
  { key: "mortgage", label: "Mortgage", types: ["mortgage"], liability: true },
];

export const LIABILITY_TYPES = new Set(["auto_loan", "personal_loan", "credit_card", "mortgage"]);
