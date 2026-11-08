import { useSyncExternalStore } from "react";

// ponytail: photos live in this browser's localStorage (keyed by first name), not in SpacetimeDB, so other phones don't see them.
// Upgrade: a `photo` column on `member` + a reducer, then read it in Avatar.
const KEY = "keystone.avatars";
const subs = new Set<() => void>();
let cache: Record<string, string> | null = null;
const load = (): Record<string, string> => {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { cache = {}; }
  return cache!;
};
const k = (name: string) => name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

export function usePhoto(name: string): string | null {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => load()[k(name)] ?? null, () => null);
}

/** Center-crop to a 96px square JPEG and save it for `name`. */
export async function savePhoto(name: string, file: File): Promise<void> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  c.getContext("2d")!.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 96, 96);
  cache = { ...load(), [k(name)]: c.toDataURL("image/jpeg", 0.8) };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage full or blocked: photo lasts this tab only */ }
  subs.forEach((f) => f());
}
