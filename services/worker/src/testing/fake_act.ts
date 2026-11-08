// A fake of the call session's `act` (phone/session.ts) for tool tests: every write is recorded in `calls`, and the spoken-yes gate
// behaves like the real one except that it does not wait 2.5 s (any earlier proposal counts) and a spent key is forgotten.
import type { ToolContext } from '../tools/registry.js';
import type { HouseholdData } from '../types.js';
import type { ExternalApis } from '../tools/external.js';

export type Act = NonNullable<ToolContext['act']>;

export function fakeAct() {
  const calls: unknown[][] = [];
  const proposed = new Set<string>();
  const rec =
    (name: string) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push([name, ...args]);
    };
  const act: Act = {
    addKidTask: rec('task'),
    depositKidJar: rec('jar'),
    approveKidTask: rec('approve'),
    setKidGoal: rec('kidgoal'),
    saveGoal: rec('goal'),
    deleteGoal: rec('goal_delete'),
    saveWhatIf: rec('whatif'),
    createProposal: rec('proposal'),
    markAlertHandled: rec('alert'),
    propose: (key) => void proposed.add(key),
    confirmable: (key) => proposed.has(key),
    consume: (key) => void proposed.delete(key),
  };
  return { act, calls, proposed };
}

/** A tool context for a call session (`withAct`) or for any other agent (no `act`: write tools must refuse). */
export function toolCtx(data: HouseholdData, withAct = true) {
  const f = fakeAct();
  const ctx: ToolContext = { data, external: {} as ExternalApis, ...(withAct ? { act: f.act } : {}) };
  return { ctx, ...f };
}
