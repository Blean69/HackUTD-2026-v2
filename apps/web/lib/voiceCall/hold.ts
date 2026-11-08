import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";

/**
 * Event handlers that turn any button into a reliable "hold to talk" control, for the Talk call and for Table Mode alike:
 *
 *   <button {...holdToTalkProps(pressTalk, releaseTalk)} className={cx(HOLD_TO_TALK_CLASS, "...")}>Hold to talk</button>
 *
 * Pointer capture means release still arrives if the finger slides off the button; `pointercancel` / lost capture / blur
 * cover the browser stealing the gesture (scroll, notification shade, tab switch). Space and Enter work from the keyboard.
 * `release` must be idempotent (the session functions are), because several of these can fire for one release.
 */
export function holdToTalkProps(press: () => void, release: () => void) {
  return {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault(); // no text selection, no focus ring flash, no synthesized mouse events
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* element detached */
      }
      press();
    },
    onPointerUp: () => release(),
    onPointerCancel: () => release(),
    onLostPointerCapture: () => release(),
    onBlur: () => release(),
    // Long-press on touch opens the context menu, which would swallow the pointerup.
    onContextMenu: (e: MouseEvent<HTMLElement>) => e.preventDefault(),
    onKeyDown(e: KeyboardEvent<HTMLElement>) {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) {
        e.preventDefault();
        press();
      }
    },
    onKeyUp(e: KeyboardEvent<HTMLElement>) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        release();
      }
    },
  };
}

/** Tailwind classes to add to the hold button: no scroll-steal, no text selection, no iOS callout on long press. */
export const HOLD_TO_TALK_CLASS = "touch-none select-none [-webkit-touch-callout:none]";
