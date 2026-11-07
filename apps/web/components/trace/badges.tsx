import { Chip, type Tone } from "@/components/ui";
import type { Provider, TraceEvent } from "@/lib/types";

/** Plain-English provider names for chips and stat lines. */
export const PROVIDER_NAME: Record<Provider, string> = {
  nvidia: "NVIDIA",
  brev: "Brev GPU",
  tenvor_nemotron: "Tenvor",
  tenvor_qwen: "Tenvor",
  cache: "Cache",
  local: "Local tool",
};

export function providerName(provider?: string): string {
  return provider ? (PROVIDER_NAME as Record<string, string>)[provider] ?? provider : "";
}

/**
 * Text, tone and tooltip for a model/provider pair.
 * Nemotron = brand green, fallback providers (tenvor / Qwen) = amber, cache = info blue, local tool = neutral.
 */
export function modelLabel(model?: string, provider?: Provider): { text: string; tone: Tone; title: string } | null {
  if (!model && !provider) return null;
  if (provider === "cache") return { text: "Cache", tone: "info", title: "Replayed from a previous identical run (DEMO_MODE=cache_first)" };
  if (provider === "local" && !model) return { text: "Local tool", tone: "neutral", title: "Deterministic tool executed by the worker, no model call" };
  const m = (model ?? "").toLowerCase();
  let name = model ? (model.split("/").pop() ?? model) : (provider ?? "");
  if (m.includes("nemotron")) {
    const size = m.includes("nano") ? "Nano" : m.includes("lightning") ? "Lightning" : m.includes("super") ? "Super" : m.includes("ultra") ? "Ultra" : m.includes("vl") ? "VL" : "";
    name = `Nemotron${size ? ` ${size}` : ""}`;
  } else if (m.includes("qwen")) name = "Qwen";
  const isFallback = provider === "tenvor_nemotron" || provider === "tenvor_qwen";
  const prov = providerName(provider);
  const tone: Tone = isFallback ? "watch" : m.includes("nemotron") ? "brand" : "neutral";
  const via = provider ? ` via ${provider === "brev" ? "our NVIDIA Brev GPU" : isFallback ? "the Tenvor fallback provider" : prov}` : "";
  return { text: prov ? `${name} · ${prov}` : name, tone, title: `${model ?? ""}${via}`.trim() };
}

export function ProviderBadge({ model, provider }: { model?: string; provider?: Provider }) {
  const l = modelLabel(model, provider);
  if (!l) return null;
  return <Chip tone={l.tone} title={l.title}>{l.text}</Chip>;
}

/** One representative event per distinct model + provider in a run (for a row of chips). Local tool steps are skipped. */
export function runProviders(events: readonly TraceEvent[]): TraceEvent[] {
  const seen = new Map<string, TraceEvent>();
  for (const e of events) if (e.model || e.provider === "cache") seen.set(`${e.model ?? ""}|${e.provider ?? ""}`, e);
  return [...seen.values()];
}
