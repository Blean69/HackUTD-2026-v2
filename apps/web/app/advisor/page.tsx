import type { Metadata } from "next";
import { AdvisorConsole } from "@/components/advisor/AdvisorConsole";

export const metadata: Metadata = { title: "Advisor console" };

export default function AdvisorPage() {
  return <AdvisorConsole />;
}
