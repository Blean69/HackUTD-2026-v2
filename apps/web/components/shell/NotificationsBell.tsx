"use client";
import { useEffect, useRef, useState } from "react";
import { IconBell, IconCheck } from "@/components/icons";
import { Button, StatusDot } from "@/components/ui";
import { ackAlert } from "@/lib/data/actions";
import { useAlerts } from "@/lib/data/hooks";
import { cx, relTime } from "@/lib/format";

/** Bell with a count badge and a popover of open alerts (fraud, scam, data quality, upcoming bills, credit). `compact` drops the border (phone top bar). */
export function NotificationsBell({ householdId, me, compact }: { householdId: string; me: string; dark?: boolean; compact?: boolean }) {
  const alerts = useAlerts(householdId);
  const open = alerts.filter((a) => !a.acknowledged_by);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setShow(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setShow(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [show]);

  const critical = open.some((a) => a.severity === "critical");
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={open.length ? `Notifications, ${open.length} need a look` : "Notifications, all clear"}
        aria-expanded={show}
        aria-haspopup="dialog"
        onClick={() => setShow((s) => !s)}
        className={cx(
          "press relative inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-2 transition-colors hover:text-ink",
          compact ? "hover:bg-surface-2" : "border border-line-strong bg-surface hover:bg-surface-2",
          show && "bg-surface-2 text-ink",
        )}
      >
        <IconBell size={18} />
        {open.length ? (
          <span className={cx("num absolute -right-1 -top-1 flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold ring-2 ring-bg", critical ? "bg-risk text-white dark:text-[#1a0706]" : "bg-brand text-brand-ink")}>{open.length > 9 ? "9+" : open.length}</span>
        ) : null}
      </button>
      {show ? (
        <div role="dialog" aria-label="Notifications" className="pop anim-pop-in fixed inset-x-3 top-16 z-50 max-h-[70dvh] overflow-hidden rounded-xl text-ink md:absolute md:inset-x-auto md:right-0 md:top-11 md:w-[380px]">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-label font-semibold">Alerts</h2>
            <span className="num text-caption text-ink-3">{open.length ? `${open.length} open` : "All clear"}</span>
          </div>
          <ul className="scroll-thin max-h-[calc(70dvh-3rem)] divide-y divide-line overflow-y-auto">
            {alerts.length === 0 ? <li className="px-4 py-6 text-center text-label text-ink-2">No alerts for this household.</li> : null}
            {alerts.slice(0, 12).map((a) => (
              <li key={a.id} className={cx("px-4 py-3", a.acknowledged_by && "opacity-60")}>
                <div className="flex items-start gap-2.5">
                  <span className="mt-1.5"><StatusDot tone={a.acknowledged_by ? "neutral" : a.severity === "critical" ? "risk" : a.severity === "warn" ? "watch" : "info"} /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-label font-medium">{a.title}</p>
                    <p className="mt-0.5 text-caption text-ink-2">{a.detail}</p>
                    <div className="mt-1.5 flex items-center gap-2 text-caption text-ink-3">
                      <span>{relTime(a.created_at)}</span>
                      {a.acknowledged_by ? (
                        <span className="inline-flex items-center gap-1"><IconCheck size={12} className="text-good" /> Handled by {a.acknowledged_by}</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="ml-auto h-7"
                          disabled={busy === a.id}
                          onClick={async () => {
                            setBusy(a.id);
                            try {
                              await ackAlert(a.id, me);
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          Mark handled
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
