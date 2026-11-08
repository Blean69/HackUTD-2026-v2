"use client";
import { usePhoto } from "@/lib/avatars";

/** Covers the initials circle with the person's uploaded photo, if any. */
export function AvatarPhoto({ name }: { name: string }) {
  const src = usePhoto(name);
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt="" className="absolute inset-0 h-full w-full rounded-full object-cover" /> : null;
}
