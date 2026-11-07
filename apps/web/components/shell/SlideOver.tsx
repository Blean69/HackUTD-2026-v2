"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { IconClose } from "@/components/icons";

/**
 * Right-hand slide-over (full-width sheet on phones). Used for "Ask Cosign" and "Agent activity".
 * Escape or a click on the scrim closes it; focus moves in on open and returns to whatever opened it.
 */
export function SlideOver({
  open, onClose, title, subtitle, icon, children, footer, label, width = 440,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  label: string;
  width?: number;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label={`Close ${label}`} tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/30" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={{ ["--w" as string]: `${width}px` }}
        className="anim-sheet md:anim-side absolute inset-x-0 bottom-0 top-12 flex flex-col rounded-t-xl border border-line bg-surface md:inset-y-0 md:left-auto md:right-0 md:top-0 md:w-[var(--w)] md:rounded-none md:border-y-0 md:border-r-0"
      >
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          {icon ? <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand-strong">{icon}</span> : null}
          <div className="min-w-0 flex-1">
            <h2 className="text-[1rem] font-semibold leading-tight">{title}</h2>
            {subtitle ? <div className="mt-0.5 text-[0.78rem] leading-snug text-ink-2">{subtitle}</div> : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={`Close ${label}`}
            className="-mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <IconClose size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? <footer className="pb-safe border-t border-line px-4 py-3 text-[0.8rem]">{footer}</footer> : null}
      </section>
    </div>
  );
}
