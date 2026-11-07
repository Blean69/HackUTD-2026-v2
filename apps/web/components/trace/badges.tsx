import { Chip, type Tone } from "@/components/ui";
import type { Provider } from "@/lib/types";

export function modelLabel(model?: string, provider?: Provider): { text: string; tone: Tone; title: string } | null {
  if (!model && !provider) return null;
  if (provider === "cache") return { text: "cache", tone: "info", title: "Replayed from a previous identical run (DEMO_MODE=cache_first)" };
  if (provider === "local" && !model) return { text: "local tool", tone: "neutral", title: "Deterministic tool executed by the worker, no model call" };
  const m = (model ?? "").toLowerCase();
  let name = model ?? provider ?? "";
  if (m.includes("nemotron")) {
    const size = m.includes("nano") ? "Nano" : m.includes("super") ? "Super" : m.includes("ultra") ? "Ultra" : m.includes("vl") ? "VL" : "";
    name = `Nemotron${size ? ` ${size}` : ""}`;
  } else if (m.includes("qwen")) name = "Qwen";
  const prov = provider === "tenvor_nemotron" || provider === "tenvor_qwen" ? "tenvor" : provider ?? "";
  const isFallback = provider === "tenvor_nemotron" || provider === "tenvor_qwen";
  return { text: prov ? `${name} · ${prov}` : name, tone: isFallback ? "accent" : m.includes("nemotron") ? "brand" : "neutral", title: `${model ?? ""}${provider ? ` via ${provider}` : ""}` };
}

export function ProviderBadge({ model, provider }: { model?: string; provider?: Provider }) {
  const l = modelLabel(model, provider);
  if (!l) return null;
  return <Chip tone={l.tone} title={l.title} className="font-mono !text-[0.68rem]">{l.text}</Chip>;
}
