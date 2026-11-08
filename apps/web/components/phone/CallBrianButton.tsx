"use client";
import { IconPhone } from "@/components/icons";
import { IconButton } from "@/components/ui";
import { cx } from "@/lib/format";
import { PHONE_NUMBER } from "@/lib/phone";
import { openCallBrian } from "@/lib/phoneUi";

/**
 * Opens the "Call Brian" panel (mounted once in AppShell).
 *   header  desktop room header: a bordered button, icon only until there is room for the words
 *   top     the top bar on phones
 */
export function CallBrianButton({ variant }: { variant: "header" | "top" }) {
  if (!PHONE_NUMBER) return null;
  if (variant === "top") {
    return (
      <IconButton label="Call Brian by phone" onClick={openCallBrian}>
        <IconPhone size={18} />
      </IconButton>
    );
  }
  return (
    <button
      type="button"
      onClick={openCallBrian}
      aria-label="Call Brian by phone"
      title="Call Brian by phone"
      className={cx("press inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-body font-semibold text-ink hover:border-ink-3/40 hover:bg-surface-2 xl:px-3")}
    >
      <IconPhone size={16} />
      <span className="hidden xl:inline">Call Brian</span>
    </button>
  );
}
