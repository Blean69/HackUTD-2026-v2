"use client";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui";

/**
 * Recharts is ~120 KB gzipped. These wrappers load it on the client after first paint, so the shell, the KPIs and the
 * lists are interactive first. The skeleton matches the chart's height, so nothing jumps when it arrives.
 */
const fill = <Skeleton className="h-64 w-full" />;

export const TrendChart = dynamic(() => import("./TrendChart").then((m) => m.TrendChart), { ssr: false, loading: () => fill });
export const CashFlowChart = dynamic(() => import("./CashFlowChart").then((m) => m.CashFlowChart), { ssr: false, loading: () => fill });
export const ScenarioChart = dynamic(() => import("@/components/whatif/ScenarioChart").then((m) => m.ScenarioChart), { ssr: false, loading: () => fill });
export const HealthRadar = dynamic(() => import("./HealthRadar").then((m) => m.HealthRadar), { ssr: false, loading: () => <Skeleton className="h-44 w-full" /> });
