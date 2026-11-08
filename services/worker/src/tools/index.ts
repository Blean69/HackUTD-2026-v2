import { detectTransactionAnomalies } from './anomalies.js';
import { creditTools } from './credit.js';
import { externalTools } from './external.js';
import { goalFeasibilityTool } from './feasibility.js';
import { kidTools } from './kids.js';
import { findSavings } from './bills.js';
import { ledgerTools } from './ledger.js';
import { ToolRegistry } from './registry.js';
import { detectScamSignalsTool } from './scam.js';
import { simulateScenario } from './simulate.js';

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
    findSavings,
  );
}

export * from './registry.js';
export { WRITE_TOOLS } from './kids.js';
export type { ExternalApis } from './external.js';
