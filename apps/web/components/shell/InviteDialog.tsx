"use client";
import { useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconClose, IconCopy, IconPhone } from "@/components/icons";
import { IconButton } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";

const row = "press flex w-full items-center gap-3 rounded-md border border-line px-3 py-3 text-left text-label font-medium text-ink hover:bg-surface-2";

/** "Add people": every way to get someone into this room is the same link, sent through the app they already use. */
export function InviteDialog({ householdId, name, onClose }: { householdId: string; name: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/room/${householdId}`;
  const text = `Join ${name} on ${PRODUCT_NAME}: ${url}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link:", url); // clipboard is blocked on plain http
    }
  };
  const share = () => navigator.share({ title: name, url }).catch(() => {});
  const opts: { label: string; sub: string; href: string }[] = [
    { label: "Text message", sub: "Opens Messages with the link", href: `sms:?&body=${encodeURIComponent(text)}` },
    { label: "WhatsApp", sub: "Send to a person or group", href: `https://wa.me/?text=${encodeURIComponent(text)}` },
    { label: "Email", sub: "Opens your mail app", href: `mailto:?subject=${encodeURIComponent(`Join ${name}`)}&body=${encodeURIComponent(text)}` },
  ];
  // Portalled to <body> for the same reason as NamePrompt: the room page animates with a transform.
  return createPortal(
    <div className="scrim fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="invite-title" onClick={onClose} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="pop anim-sheet w-full max-w-md rounded-t-xl p-5 pb-safe sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="invite-title" className="display text-h3">Add people</h2>
            <p className="mt-0.5 text-label text-ink-2">Anyone with the link joins this room live and picks a name.</p>
          </div>
          <IconButton label="Close" onClick={onClose} autoFocus><IconClose size={16} /></IconButton>
        </div>
        <div className="mt-4 space-y-2">
          <button type="button" className={row} onClick={copy}>
            {copied ? <IconCheck size={18} className="text-good" /> : <IconCopy size={18} />}
            <span className="flex-1"><span className="block">{copied ? "Link copied" : "Copy link"}</span><span className="block text-caption font-normal text-ink-3">{url}</span></span>
          </button>
          {typeof navigator !== "undefined" && "share" in navigator ? (
            <button type="button" className={row} onClick={share}>
              <IconPhone size={18} />
              <span className="flex-1"><span className="block">Share…</span><span className="block text-caption font-normal text-ink-3">AirDrop, apps, nearby devices</span></span>
            </button>
          ) : null}
          {opts.map((o) => (
            <a key={o.label} className={row} href={o.href} target="_blank" rel="noreferrer">
              <span className="w-[18px]" aria-hidden="true" />
              <span className="flex-1"><span className="block">{o.label}</span><span className="block text-caption font-normal text-ink-3">{o.sub}</span></span>
            </a>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
