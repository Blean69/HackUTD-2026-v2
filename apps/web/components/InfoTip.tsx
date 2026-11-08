"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { IconInfo } from "./icons";

const GAP = 6; // px between the icon and the bubble
const EDGE = 12; // px kept clear of the viewport edge
const MAX_W = 288; // px, about 18rem

/**
 * Info glyph next to card titles. Tap or click toggles an explanation bubble (phones have no hover);
 * hover and keyboard focus also open it on desktop. Escape, an outside tap or scrolling closes it.
 * The bubble is fixed-positioned and clamped to the viewport, so icons at the screen edge stay readable.
 */
export function InfoTip({ text, label }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false); // opened by a tap/click: stays open until dismissed
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback(() => {
    setOpen(false);
    setPinned(false);
  }, []);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const width = Math.min(MAX_W, vw - EDGE * 2);
    const left = Math.min(Math.max(r.left + r.width / 2 - width / 2, EDGE), vw - width - EDGE);
    const h = bubble.current?.offsetHeight ?? 0;
    const below = r.bottom + GAP;
    const top = below + h > window.innerHeight - EDGE && r.top - GAP - h > EDGE ? r.top - GAP - h : below;
    setPos({ top, left, width });
  }, [open, text]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        btn.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !bubble.current?.contains(t)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label ? `About ${label}` : "More info"}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => {
          if (pinned) close();
          else {
            setOpen(true);
            setPinned(true);
          }
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => {
          if (!pinned) setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          if (!pinned) setOpen(false);
        }}
        className="-m-1 inline-flex rounded p-1 align-middle text-ink-3 transition-colors hover:text-ink focus-visible:text-ink"
      >
        <IconInfo size={14} />
      </button>
      {open ? (
        <div
          ref={bubble}
          id={id}
          role="tooltip"
          style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { top: -9999, left: -9999, width: MAX_W }}
          className="pop anim-pop-in fixed z-50 rounded-md px-3 py-2 text-left text-label font-normal normal-case tracking-normal text-ink-2"
        >
          {text}
        </div>
      ) : null}
    </>
  );
}
