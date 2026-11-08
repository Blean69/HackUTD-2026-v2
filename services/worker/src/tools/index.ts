import { detectTransactionAnomalies } from './anomalies.js';
import { creditTools } from './credit.js';
import { externalTools } from './external.js';
import { familyTools, FAMILY_WRITE_TOOLS } from './family.js';
import { goalFeasibilityTool } from './feasibility.js';
import { goalTools, GOAL_WRITE_TOOLS } from './goals.js';
import { kidTools, WRITE_TOOLS as KID_WRITE_TOOLS } from './kids.js';
import { findSavings } from './bills.js';
import { ledgerTools } from './ledger.js';
import { ToolRegistry } from './registry.js';
import { detectScamSignalsTool } from './scam.js';
import { simulateScenario } from './simulate.js';
import { studioTools, STUDIO_WRITE_TOOLS } from './studio.js';

/** The single tool registry. To add a tool: create a `defineTool({...})` and register it here. */
export function buildRegistry(): ToolRegistry {
  return new ToolRegistry().register(
    ...ledgerTools,
    ...creditTools,
    simulateScenario,
    goalFeasibilityTool,
    detectTransactionAnomalies,
    detectScamSignalsTool,
    ...externalTools,
    ...kidTools,
    ...goalTools,
    ...studioTools,
    ...familyTools,
    findSavings,
  );
}

/** Tools that change data (each needs a spoken yes and Brian's call session): kept out of agents that act without a person confirming (Ask, Table Mode, what-ifs). */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([...KID_WRITE_TOOLS, ...GOAL_WRITE_TOOLS, ...STUDIO_WRITE_TOOLS, ...FAMILY_WRITE_TOOLS]);

export * from './registry.js';
export type { ExternalApis } from './external.js';
