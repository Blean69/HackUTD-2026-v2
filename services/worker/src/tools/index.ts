import { detectTransactionAnomalies } from './anomalies.js';
import { externalTools } from './external.js';
import { goalFeasibilityTool } from './feasibility.js';
import { ledgerTools } from './ledger.js';
import { ToolRegistry } from './registry.js';
import { detectScamSignalsTool } from './scam.js';
import { simulateScenario } from './simulate.js';

/** The single tool registry. To add a tool: create a `defineTool({...})` and register it here. */
export function buildRegistry(): ToolRegistry {
  return new ToolRegistry().register(
    ...ledgerTools,
    simulateScenario,
    goalFeasibilityTool,
    detectTransactionAnomalies,
    detectScamSignalsTool,
    ...externalTools,
  );
}

export * from './registry.js';
export type { ExternalApis } from './external.js';
