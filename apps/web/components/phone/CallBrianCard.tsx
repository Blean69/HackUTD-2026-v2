"use client";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { IconCheck, IconLock, IconPhone } from "@/components/icons";
import { Button, Card, Chip, IconTile, Skeleton, Spinner } from "@/components/ui";
import { useConnection } from "@/lib/data/connection";
import { useHousehold } from "@/lib/data/hooks";
import { clearPhoneCode, setPhoneCode, usePhoneAccess } from "@/lib/data/phone";
import { cx, relTime } from "@/lib/format";
import { PHONE_DISPLAY, PHONE_HREF, PHONE_NUMBER, PIN_LENGTH, weakPinReason } from "@/lib/phone";
import { digitsToPin, emptyDigits, isComplete, PinBoxes } from "./PinBoxes";

/**
 * "Call Brian by phone": the number (tap to call), whether this household has a 5-digit code, and a small editor to set or change it.
 * Brian asks the caller for that code, so each household reaches only its own data. Seeded demo households show "Demo code: ask the
 * team" and no editor; only the household's creator can change its code. `bare` drops the card's own title (inside a titled panel).
 */
export function CallBrianCard({ householdId, bare, className }: { householdId: string; bare?: boolean; className?: string }) {
  const household = useHousehold(householdId);
  const { identity } = useConnection();
  const access = usePhoneAccess(householdId);

  const [editing, setEditing] = useState(false);
  const [digits, setDigits] = useState(emptyDigits);
  const [again, setAgain] = useState(emptyDigits);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"set" | "cleared" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** Hand focus back to the button that opened the editor once it closes. */
  const refocusOpener = () => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-opener]")?.focus());

  if (!PHONE_NUMBER) return null;

  const demo = !!household && !household.owner;
  const isOwner = !!household?.owner && household.owner === identity;
  const canEdit = access.phase === "ready" && isOwner;

  const pin = digitsToPin(digits);
  const complete = isComplete(digits);
  const weak = complete ? weakPinReason(pin) : "";
  const confirmed = isComplete(again);
  const mismatch = complete && confirmed && pin !== digitsToPin(again);
  const canSave = complete && confirmed && !weak && !mismatch && !busy;

  function reset() {
    setDigits(emptyDigits());
    setAgain(emptyDigits());
    setShow(false);
    setError(null);
  }
  function close() {
    reset();
    setEditing(false);
    refocusOpener();
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy("save");
    setError(null);
    try {
      await setPhoneCode(householdId, pin);
      reset();
      setEditing(false);
      setSaved("set");
      refocusOpener();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't save that code. Please try again.");
    } finally {
      setBusy(null);
    }
  }
  async function remove() {
    setBusy("clear");
    setError(null);
    try {
      await clearPhoneCode(householdId);
      reset();
      setEditing(false);
      setSaved("cleared");
      refocusOpener();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't remove the code. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  let statusLine: ReactNode;
  if (demo) statusLine = <span className="font-medium text-ink">Demo code: ask the team</span>;
  else if (access.phase === "loading" || (!household && access.phase !== "offline")) statusLine = <Skeleton className="h-5 w-40" />;
  else if (access.phase === "offline") statusLine = <span className="text-ink-2">Codes need the live database; this preview is offline.</span>;
  else if (access.phase === "unsupported") statusLine = <span className="text-ink-2">Codes aren&apos;t available on this server yet.</span>;
  else if (access.hasPin)
    statusLine = (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <Chip tone="good"><IconCheck size={12} strokeWidth={2.6} /> Code set</Chip>
        {access.updatedAt ? <span className="text-caption text-ink-3">changed {relTime(access.updatedAt)}</span> : null}
      </span>
    );
  else statusLine = <Chip tone="watch">No code yet</Chip>;

  return (
    <Card className={cx("p-4", className)}>
      <div ref={root}>
        {bare ? null : (
          <div className="flex items-start gap-3">
            <IconTile size={40}><IconPhone size={20} /></IconTile>
            <div className="min-w-0 flex-1">
              <h2 className="text-lead font-semibold leading-tight tracking-tight">Call Brian by phone</h2>
              <p className="mt-0.5 text-label leading-snug text-ink-2">Prefer a phone? Brian answers the same questions out loud, on any phone.</p>
            </div>
          </div>
        )}

        <div className={cx("flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-lg bg-surface-2 px-3.5 py-3", !bare && "mt-3")}>
          <div className="min-w-0 flex-1 basis-44">
            <p className="text-caption text-ink-3">Phone number</p>
            <p className="num text-[1.25rem] font-semibold leading-tight tracking-tight">{PHONE_DISPLAY}</p>
          </div>
          <a
            href={PHONE_HREF}
            aria-label={`Call Brian at ${PHONE_DISPLAY}`}
            className="press inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-brand px-4 text-body font-semibold text-brand-ink hover:bg-brand-hover"
          >
            <IconPhone size={16} /> Tap to call
          </a>
        </div>

        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <p className="text-label font-medium">Your {PIN_LENGTH}-digit code</p>
              <div className="mt-1 min-h-6 text-body" aria-live="polite">{statusLine}</div>
            </div>
            {canEdit && !editing ? (
              <Button data-opener variant={access.hasPin ? "secondary" : "primary"} onClick={() => { setSaved(null); setEditing(true); }}>
                {access.hasPin ? "Change code" : `Set your ${PIN_LENGTH}-digit code`}
              </Button>
            ) : null}
          </div>

          {saved && !editing ? (
            <p role="status" className="mt-2 inline-flex items-center gap-1.5 text-label font-medium text-good">
              <IconCheck size={15} strokeWidth={2.6} /> {saved === "set" ? "Code saved. It works on your next call." : "Code removed. Callers can't use it any more."}
            </p>
          ) : null}

          {!demo && access.phase === "ready" && household && !isOwner ? (
            <p className="mt-2 text-label leading-snug text-ink-3">Only the person who set up this household can change its code.</p>
          ) : null}

          {editing && canEdit ? (
            <form onSubmit={save} className="anim-fade mt-3 rounded-lg border border-line p-3.5" aria-label={access.hasPin ? "Change your phone code" : "Set your phone code"}>
              <p id="pin-new-h" className="mb-2 text-label font-medium">{access.hasPin ? "New code" : "Choose a code"}</p>
              <PinBoxes label="New code" digits={digits} onChange={setDigits} show={show} autoFocus invalid={!!weak} disabled={!!busy} describedBy={weak ? "pin-weak" : undefined} />
              {weak ? <p id="pin-weak" role="alert" className="mt-1.5 text-label text-risk">{weak}</p> : null}

              <p className="mb-2 mt-3.5 text-label font-medium">Type it again to confirm</p>
              <PinBoxes label="Confirm code" digits={again} onChange={setAgain} show={show} invalid={mismatch} disabled={!!busy} describedBy={mismatch ? "pin-mismatch" : undefined} />
              {mismatch ? <p id="pin-mismatch" role="alert" className="mt-1.5 text-label text-risk">The two codes don&apos;t match.</p> : null}

              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-pressed={show}
                className="mt-3 rounded text-label font-medium text-brand-strong hover:underline"
              >
                {show ? "Hide digits" : "Show digits"}
              </button>

              {error ? <p role="alert" className="mt-2 rounded-lg bg-risk-soft px-3 py-2 text-label leading-snug text-risk">{error}</p> : null}

              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={!canSave}>
                  {busy === "save" ? <><Spinner size={15} /> Saving…</> : "Save code"}
                </Button>
                <Button variant="ghost" onClick={close} disabled={!!busy}>Cancel</Button>
                {access.hasPin ? (
                  <Button variant="ghost" onClick={() => void remove()} disabled={!!busy} className="ml-auto">
                    {busy === "clear" ? <><Spinner size={15} /> Removing…</> : "Remove code"}
                  </Button>
                ) : null}
              </div>
            </form>
          ) : null}

          <p className="mt-3 flex items-start gap-1.5 text-label leading-snug text-ink-3">
            <IconLock size={14} className="mt-0.5 shrink-0" />
            <span>Brian will ask for this code when you call. Only a scrambled version is stored, never the code itself.</span>
          </p>
        </div>
      </div>
    </Card>
  );
}
