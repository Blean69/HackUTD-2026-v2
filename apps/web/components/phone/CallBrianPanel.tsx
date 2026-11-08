"use client";
import { SlideOver } from "@/components/shell/SlideOver";
import { IconPhone } from "@/components/icons";
import { closeCallBrian, useCallBrianOpen } from "@/lib/phoneUi";
import { CallBrianCard } from "./CallBrianCard";

/** The "Call Brian" slide-over opened from the header. Loaded on first use (AppShell imports it dynamically). */
export function CallBrianPanel({ householdId }: { householdId: string }) {
  const open = useCallBrianOpen();
  return (
    <SlideOver
      open={open}
      onClose={closeCallBrian}
      label="Call Brian"
      title="Call Brian"
      subtitle="Brian picks up the phone too, with the same numbers as the Talk button."
      icon={<IconPhone size={18} />}
      width={420}
    >
      <div className="p-4">
        <CallBrianCard householdId={householdId} bare />
      </div>
    </SlideOver>
  );
}
