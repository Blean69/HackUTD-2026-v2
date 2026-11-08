"use client";
import { IconPhone } from "@/components/icons";
import { cx } from "@/lib/format";
import { PHONE_DISPLAY, PHONE_HREF, PHONE_NUMBER } from "@/lib/phone";

/** One line for the bottom of the Talk call sheet: "Prefer a phone? Call +1 (945) 403-0355" (tap to call on a phone). */
export function PhoneHint({ className }: { className?: string }) {
  if (!PHONE_NUMBER) return null;
  return (
    <p className={cx("flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-center text-label text-ink-2", className)}>
      <IconPhone size={14} className="text-ink-3" />
      <span>Prefer a phone?</span>
      <a href={PHONE_HREF} className="num rounded font-semibold text-brand-strong hover:underline">
        Call {PHONE_DISPLAY}
      </a>
    </p>
  );
}
