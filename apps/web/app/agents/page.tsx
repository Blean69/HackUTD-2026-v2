import type { Metadata } from "next";
import { AgentWall } from "@/components/agents/AgentWall";

export const metadata: Metadata = { title: "Agent wall" };

export default function AgentsPage() {
  return <AgentWall />;
}
