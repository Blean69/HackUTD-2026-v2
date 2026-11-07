// Workflow registry keyed by workflow name. To add one (e.g. plaid_sync): write a WorkflowDef and call
// registerWorkflow() here or from your own module before the worker starts.
import { coachWorkflow } from './coach.js';
import { dataQualityWorkflow, scamCheckWorkflow } from './audit.js';
import { huddleWorkflow } from './huddle.js';
import { plaidSyncWorkflow } from './plaid_sync.js';
import type { WorkflowDef } from './types.js';
import { whatIfWorkflow } from './what_if.js';

const registry = new Map<string, WorkflowDef>();

export function registerWorkflow(def: WorkflowDef): void {
  registry.set(def.name, def);
}
export function getWorkflow(name: string): WorkflowDef | undefined {
  return registry.get(name);
}
export function workflowNames(): string[] {
  return [...registry.keys()];
}

for (const w of [huddleWorkflow, whatIfWorkflow, coachWorkflow, dataQualityWorkflow, scamCheckWorkflow, plaidSyncWorkflow]) registerWorkflow(w);

export type { JobInfo, WorkflowDef, WorkflowEnv } from './types.js';
