"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { DEMO_HOUSEHOLD_ID, PRODUCT_NAME } from "@/lib/constants";
import { cx } from "@/lib/format";
import { ConnectionBadge } from "./ConnectionBadge";
import { IconBot, IconBriefcase, IconHome, IconUsers, KeystoneMark } from "./icons";
import { ThemeToggle } from "./ThemeToggle";

type Mood = "me" | "advisor" | "agents";

const NAV = [
  { href: "/", label: "Home", Icon: IconHome, match: (p: string) => p === "/" },
  { href: `/room/${DEMO_HOUSEHOLD_ID}`, label: "Room", Icon: IconUsers, match: (p: string) => p.startsWith("/room") || p === "/me" },
  { href: "/agents", label: "Agents", Icon: IconBot, match: (p: string) => p.startsWith("/agents") },
  { href: "/advisor", label: "Advisor", Icon: IconBriefcase, match: (p: string) => p.startsWith("/advisor") },
];

export function Shell({ mood, children, maxWidth = "max-w-6xl", bare }: { mood: Mood; children: ReactNode; maxWidth?: string; bare?: boolean }) {
  const path = usePathname() ?? "/";
  return (
    <div data-mood={mood} className="min-h-dvh bg-bg text-ink">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
        <div className={cx("mx-auto flex h-14 items-center gap-3 px-4 sm:px-6", maxWidth)}>
          <Link href="/" className="flex items-center gap-2 rounded-lg text-brand" aria-label={`${PRODUCT_NAME} home`}>
            <KeystoneMark size={26} />
            <span className="font-display text-[1.15rem] font-bold tracking-tight text-ink">{PRODUCT_NAME}</span>
          </Link>
          <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Primary">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={n.match(path) ? "page" : undefined}
                className={cx("rounded-lg px-3 py-1.5 text-sm font-medium transition-colors", n.match(path) ? "bg-brand-soft text-brand-strong" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <ConnectionBadge />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <div className={bare ? "" : cx("mx-auto px-4 pb-28 pt-5 sm:px-6 md:pb-12", maxWidth)}>{children}</div>
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-safe backdrop-blur md:hidden" aria-label="Primary">
        <ul className="mx-auto grid max-w-md grid-cols-4">
          {NAV.map((n) => {
            const active = n.match(path);
            return (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={cx("flex flex-col items-center gap-0.5 py-2 text-[0.7rem] font-medium", active ? "text-brand-strong" : "text-ink-3")}
                >
                  <span className={cx("flex h-7 w-12 items-center justify-center rounded-full", active && "bg-brand-soft")}>
                    <n.Icon size={19} />
                  </span>
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
