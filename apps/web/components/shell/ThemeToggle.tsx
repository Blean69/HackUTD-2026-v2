"use client";
import { IconMonitor, IconMoon, IconSun } from "@/components/icons";
import { Segmented } from "@/components/ui";
import { setThemePref, useThemePref, type ThemePref } from "./theme";

const OPTIONS: { value: ThemePref; label: React.ReactNode; title: string }[] = [
  { value: "system", label: <IconMonitor size={15} />, title: "Match the device" },
  { value: "light", label: <IconSun size={15} />, title: "Light theme" },
  { value: "dark", label: <IconMoon size={15} />, title: "Dark theme" },
];

/** System / Light / Dark, three icons in a segmented control. Lives in the sidebar footer (and so in the phone menu). */
export function ThemeToggle({ className, withLabel }: { className?: string; withLabel?: boolean }) {
  const pref = useThemePref();
  const control = <Segmented label="Theme" size="sm" value={pref} onChange={setThemePref} options={OPTIONS} className={className} />;
  if (!withLabel) return control;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-caption text-ink-3">Theme</span>
      {control}
    </div>
  );
}
