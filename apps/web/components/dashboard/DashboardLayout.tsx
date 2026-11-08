"use client";
import { createPortal } from "react-dom";
import { useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { IconClose, IconDashboard, IconGrip, IconPlus } from "@/components/icons";
import { Button } from "@/components/ui";
import { cx } from "@/lib/format";

type Icon = (p: { size?: number; className?: string }) => ReactNode;

export type DashCard = {
  id: string;
  title: string;
  icon: Icon;
  /** The card's width from `lg` up, as static Tailwind classes. Below `lg` the card's own classes apply, unchanged. */
  span: string;
  /** Several grid items that move as one: from `lg` they sit on a 12-column sub-grid, so their own spans still apply. */
  group?: boolean;
  node: ReactNode;
};

type Layout = { order: string[]; hidden: string[] };
type Drop = { bank: true } | { id: string; after: boolean; vertical: boolean };
type Drag = { id: string; from: "grid" | "bank"; x: number; y: number };

/* ---- Per-viewer layout, kept in this browser's localStorage per household (the dashboard is shared; the layout is not). */
const KEY = "app.dashboardLayout.v1.";
const cache = new Map<string, string | null>();
const listeners = new Set<() => void>();

function readRaw(householdId: string): string | null {
  if (cache.has(householdId)) return cache.get(householdId) ?? null;
  let v: string | null = null;
  try {
    v = localStorage.getItem(KEY + householdId);
  } catch {
    /* blocked storage: the default layout */
  }
  cache.set(householdId, v);
  return v;
}

function writeLayout(householdId: string, layout: Layout | null) {
  const v = layout ? JSON.stringify(layout) : null;
  cache.set(householdId, v);
  try {
    if (v === null) localStorage.removeItem(KEY + householdId);
    else localStorage.setItem(KEY + householdId, v);
  } catch {
    /* private mode or full: the layout lasts this tab only */
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Saved layout, cleaned against the cards on screen today. A card added later appears at its default place. */
function parseLayout(raw: string | null, ids: string[]): Layout {
  const def = { order: ids, hidden: [] };
  if (!raw) return def;
  try {
    const j = JSON.parse(raw) as Partial<Layout> | null;
    if (!j || !Array.isArray(j.order) || !Array.isArray(j.hidden)) return def;
    const known = new Set(ids);
    const order = [...new Set(j.order.filter((x): x is string => typeof x === "string" && known.has(x)))];
    ids.forEach((id, i) => {
      if (!order.includes(id)) order.splice(Math.min(i, order.length), 0, id);
    });
    return { order, hidden: j.hidden.filter((x): x is string => typeof x === "string" && known.has(x)) };
  } catch {
    return def;
  }
}

function placeAt(order: string[], id: string, target: string, after: boolean) {
  const next = order.filter((x) => x !== id);
  const i = next.indexOf(target);
  if (i < 0) return order;
  next.splice(after ? i + 1 : i, 0, id);
  return next;
}

/**
 * The dashboard's bento grid with a desktop-only custom layout: from `lg` each card has a drag handle (move, hide), and a
 * card bank holds the hidden ones. The DOM keeps the default order; the layout is CSS `order` and `lg:hidden`, so phones
 * and tablets (where each wrapper is `display: contents`) render exactly as before, and cards never remount on a move.
 * `cards` is in DOM (phone) order; `defaultOrder` is the desktop reading order, which differs where a card has `md:order-*`.
 */
export function DashboardLayout({ householdId, cards, defaultOrder }: { householdId: string; cards: DashCard[]; defaultOrder: string[] }) {
  const idsKey = defaultOrder.filter((id) => cards.some((c) => c.id === id)).join("|");
  const raw = useSyncExternalStore(subscribe, () => readRaw(householdId), () => null);
  const layout = useMemo(() => parseLayout(raw, idsKey.split("|")), [raw, idsKey]);
  const [open, setOpen] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const bankRef = useRef<HTMLDivElement>(null);

  const hidden = new Set(layout.hidden);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const banked = layout.order.filter((id) => hidden.has(id)).flatMap((id) => byId.get(id) ?? []);
  const save = (l: Layout) => writeLayout(householdId, l);
  const hide = (id: string) => save({ order: layout.order, hidden: [...layout.hidden.filter((x) => x !== id), id] });
  const show = (id: string, order = layout.order) => save({ order, hidden: layout.hidden.filter((x) => x !== id) });

  /** Keyboard: arrows move a card one place among the visible cards, Delete hides it. */
  const onHandleKey = (e: ReactKeyboardEvent, id: string) => {
    const visible = layout.order.filter((x) => !hidden.has(x));
    const i = visible.indexOf(id);
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      hide(id);
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowUp") && i > 0) {
      e.preventDefault();
      save({ order: placeAt(layout.order, id, visible[i - 1], false), hidden: layout.hidden });
    } else if ((e.key === "ArrowRight" || e.key === "ArrowDown") && i >= 0 && i < visible.length - 1) {
      e.preventDefault();
      save({ order: placeAt(layout.order, id, visible[i + 1], true), hidden: layout.hidden });
    }
  };

  /** Where a drop at (x, y) lands: the bank, or before/after the nearest visible card. */
  const hitTest = (x: number, y: number, id: string, from: Drag["from"]): Drop | null => {
    const b = bankRef.current?.getBoundingClientRect();
    if (b && b.width && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return from === "grid" ? { bank: true } : null;
    const grid = gridRef.current;
    if (!grid) return null;
    const g = grid.getBoundingClientRect();
    if (x < g.left - 48 || x > g.right + 48 || y < g.top - 48 || y > g.bottom + 48) return null;
    let best: { id: string; r: DOMRect } | null = null;
    let bestD = Infinity;
    for (const el of grid.querySelectorAll<HTMLElement>(":scope > [data-dnd-id]")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = { id: el.dataset.dndId ?? "", r };
      }
    }
    if (!best || best.id === id) return null;
    const vertical = best.r.width > g.width * 0.75;
    const after = vertical ? y > best.r.top + best.r.height / 2 : x > best.r.left + best.r.width / 2;
    return { id: best.id, after, vertical };
  };

  /** Pointer drag (mouse and pen; desktop only). A press that moves less than 5 px stays a click. Escape cancels. */
  const startDrag = (e: ReactPointerEvent, id: string, from: Drag["from"]) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let live = false;
    let cur: Drop | null = null;
    const root = document.documentElement;
    const onMove = (ev: PointerEvent) => {
      if (!live) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        live = true;
        root.style.cursor = "grabbing";
        root.style.userSelect = "none";
      }
      cur = hitTest(ev.clientX, ev.clientY, id, from);
      // Near the top or bottom edge, scroll so a far card or the bank is reachable (not while over the bank tray).
      if (!cur || !("bank" in cur)) {
        if (ev.clientY < 56) window.scrollBy(0, -18);
        else if (ev.clientY > window.innerHeight - 56) window.scrollBy(0, 18);
      }
      setDrag({ id, from, x: ev.clientX, y: ev.clientY });
      setDrop(cur);
    };
    const end = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      root.style.cursor = "";
      root.style.userSelect = "";
      if (live && commit && cur) {
        if ("bank" in cur) hide(id);
        else if (from === "bank") show(id, placeAt(layout.order, id, cur.id, cur.after));
        else save({ order: placeAt(layout.order, id, cur.id, cur.after), hidden: layout.hidden });
      }
      setDrag(null);
      setDrop(null);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") end(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  };

  const dragged = drag ? byId.get(drag.id) : undefined;
  const overBank = drop !== null && "bank" in drop;
  const floating = !open && drag?.from === "grid";
  const bankVisible = open || floating;
  const DragIcon = dragged?.icon;

  // While dragging with the bank closed, it floats as a tray at the bottom of the screen (portalled: `main` animates with a
  // transform, which would pin a fixed element to it instead of the viewport).
  const bank = (
    <div
      ref={bankRef}
      id="card-bank"
      role="region"
      aria-label="Card bank"
      data-dnd-bank=""
      className={cx(
        "card z-30 hidden p-3 transition-[border-color,box-shadow,background-color] duration-150 lg:block",
        floating ? "pop motion-pop fixed bottom-6 left-1/2 w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2" : "sticky top-2 mb-3 shadow-[var(--shadow-pop)]",
        overBank && "border-brand bg-brand-soft ring-2 ring-brand/40",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-label text-ink-3">
          <span className="font-semibold text-ink">Cards</span>
          <span className="num"> · {banked.length} hidden</span>
          <span> · {overBank ? "Drop to hide this card" : drag?.from === "bank" ? "Drop it on the dashboard" : "Drag a card here to hide it; drag a tile onto the dashboard to add it"}</span>
        </p>
        {floating ? null : (
          <Button size="sm" variant="ghost" onClick={() => writeLayout(householdId, null)} disabled={raw === null}>
            Reset layout
          </Button>
        )}
      </div>
      <ul className="mt-2 flex min-h-9 flex-wrap gap-2">
        {banked.map((c) => {
          const Icon = c.icon;
          return (
            <li
              key={c.id}
              data-bank-tile={c.id}
              onPointerDown={(e) => startDrag(e, c.id, "bank")}
              className={cx(
                "flex cursor-grab select-none items-center gap-2 rounded-md border border-line bg-surface-2 py-1 pl-1.5 pr-1 text-label transition-opacity active:cursor-grabbing",
                drag?.id === c.id && "opacity-50",
              )}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded bg-surface text-ink-2"><Icon size={14} /></span>
              <span className="font-medium text-ink">{c.title}</span>
              <button
                type="button"
                aria-label={`Add ${c.title}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => show(c.id)}
                className="press inline-flex h-6 items-center gap-1 rounded px-1.5 text-caption font-semibold text-brand-strong hover:bg-surface hover:text-ink"
              >
                <IconPlus size={12} />Add
              </button>
            </li>
          );
        })}
        {!banked.length ? (
          <li className="flex h-9 flex-1 items-center rounded-md border border-dashed border-line-strong px-3 text-caption text-ink-3">
            Every card is on the dashboard. Drag one here by its handle to hide it.
          </li>
        ) : null}
      </ul>
    </div>
  );

  return (
    <>
      <div className="mb-2 hidden items-center justify-end gap-2 lg:flex">
        <Button size="sm" variant={open ? "secondary" : "ghost"} aria-expanded={open} aria-controls="card-bank" onClick={() => setOpen((o) => !o)}>
          <IconDashboard size={16} />
          {open ? "Done" : "Customize"}
        </Button>
      </div>

      {bankVisible ? (floating ? createPortal(bank, document.body) : bank) : null}

      <div ref={gridRef} className="grid grid-cols-12 gap-3 lg:grid-flow-dense">
        {cards.map((c) => {
          const off = hidden.has(c.id);
          const lifted = drag?.from === "grid" && drag.id === c.id;
          const line = drop && !("bank" in drop) && drop.id === c.id ? drop : null;
          return (
            <div
              key={c.id}
              data-dnd-id={c.id}
              style={{ order: layout.order.indexOf(c.id) }}
              className={cx(
                "group/dnd contents",
                off ? "lg:hidden" : c.group ? "lg:relative lg:grid lg:grid-cols-12 lg:gap-3" : "lg:relative lg:block",
                c.span,
                "lg:rounded-lg lg:transition-[opacity,transform,box-shadow] lg:duration-200",
                lifted && "lg:-translate-y-1 lg:opacity-60 lg:shadow-[var(--shadow-pop)]",
              )}
            >
              {c.node}
              {off ? null : (
                <div className="absolute -top-3.5 right-3 z-20 hidden items-center rounded-full border border-line-strong bg-surface p-0.5 text-ink-3 opacity-0 shadow-[var(--shadow-pop)] transition-opacity duration-150 focus-within:opacity-100 group-hover/dnd:opacity-100 lg:flex">
                  <button
                    type="button"
                    aria-label={`Move ${c.title}`}
                    title="Drag to move or to the card bank. Arrow keys move it; Delete hides it."
                    onPointerDown={(e) => startDrag(e, c.id, "grid")}
                    onKeyDown={(e) => onHandleKey(e, c.id)}
                    className="flex h-5 w-6 cursor-grab touch-none items-center justify-center rounded-full hover:bg-surface-2 hover:text-ink active:cursor-grabbing"
                  >
                    <IconGrip size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Hide ${c.title}`}
                    title="Hide (moves it to the card bank)"
                    onClick={() => hide(c.id)}
                    className="flex h-5 w-6 items-center justify-center rounded-full hover:bg-surface-2 hover:text-ink"
                  >
                    <IconClose size={12} />
                  </button>
                </div>
              )}
              {line ? (
                <span
                  aria-hidden="true"
                  className={cx(
                    "pointer-events-none absolute z-20 hidden rounded-full bg-brand shadow-[0_0_0_3px_var(--brand-soft)] lg:block",
                    line.vertical ? cx("inset-x-2 h-[3px]", line.after ? "-bottom-[7.5px]" : "-top-[7.5px]") : cx("inset-y-2 w-[3px]", line.after ? "-right-[7.5px]" : "-left-[7.5px]"),
                  )}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {drag && dragged && DragIcon ? createPortal(
        <div className="pop pointer-events-none fixed z-50 hidden items-center gap-2 rounded-lg px-2.5 py-1.5 text-label font-medium text-ink lg:flex" style={{ left: drag.x + 14, top: drag.y + 14 }}>
          <DragIcon size={14} />
          {dragged.title}
          {overBank ? <span className="text-caption font-normal text-ink-3">· hide</span> : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
