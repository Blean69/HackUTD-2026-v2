"use client";
import { IconMic } from "@/components/icons";
import { Card, IconTile } from "@/components/ui";
import { PRODUCT_NAME } from "@/lib/constants";
import { useVoiceStatus } from "@/lib/voiceCall/health";
import { SUGGESTIONS } from "@/lib/voiceCall/session";
import { TalkButton, VOICE_OFFLINE_TEXT } from "./TalkButton";

/** "Ask out loud" card for the Dashboard and What-If Studio. The sample question is the one the demo script uses. */
export function AskOutLoudCard({ className }: { className?: string }) {
  const voice = useVoiceStatus();
  const sample = SUGGESTIONS[2];
  return (
    <Card className={className}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
        <IconTile size={44}><IconMic size={22} /></IconTile>
        <div className="min-w-0 flex-1 basis-60">
          <h2 className="text-[0.95rem] font-semibold leading-tight tracking-tight">Ask out loud</h2>
          <p className="mt-0.5 text-[1rem] font-medium leading-snug text-ink">&ldquo;{sample}&rdquo;</p>
          <p className="mt-0.5 text-[0.78rem] leading-snug text-ink-3">
            {voice === "down" ? VOICE_OFFLINE_TEXT : `Talk it through with ${PRODUCT_NAME}. It runs the numbers on your accounts and shows its steps in the Agent Trail.`}
          </p>
        </div>
        <TalkButton variant="card" className="inline-flex w-full sm:w-auto [&>button]:w-full sm:[&>button]:w-auto" />
      </div>
    </Card>
  );
}
