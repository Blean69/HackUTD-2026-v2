import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentTrail } from "@/components/agents/AgentTrail";

export const metadata: Metadata = { title: "Agent Trail" };

export default function AgentsPage() {
  // AgentTrail reads `?run=<run_id>` with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <AgentTrail />
    </Suspense>
  );
}
