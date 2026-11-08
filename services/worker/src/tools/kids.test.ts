import { describe, expect, it } from 'vitest';
import type { HouseholdData } from '../types.js';
import { addKidChore, addToKidJar, findKid, getKids } from './kids.js';
import type { ToolContext } from './registry.js';

const data = {
  members: [
    { id: 'mem_p', household_id: 'hh', name: 'Marisol Rivera', age: 38, role: 'parent', income_annual: 72000 },
    { id: 'mem_s', household_id: 'hh', name: 'Sofia Rivera', age: 15, role: 'child', income_annual: 0 },
    { id: 'mem_m', household_id: 'hh', name: 'Mateo Rivera', age: 9, role: 'child', income_annual: 0 },
  ],
  kid_jars: [{ member_id: 'mem_s', balance: 42.5, earned_total: 60, goal_title: 'Concert tickets', goal_target: 120 }],
  kid_tasks: [{ id: 'kt1', member_id: 'mem_s', title: 'Walk the dog', reward: 5, status: 'open' }],
} as unknown as HouseholdData;

function ctx(withAct = true) {
  const calls: unknown[][] = [];
  const c: ToolContext = {
    data,
    external: {} as ToolContext['external'],
    ...(withAct ? { act: { addKidTask: async (...a: unknown[]) => void calls.push(['task', ...a]), depositKidJar: async (...a: unknown[]) => void calls.push(['jar', ...a]) } } : {}),
  };
  return { c, calls };
}

describe('Brian controls Kids and Teens', () => {
  it('finds a kid by first name, and lists the kids when the name is wrong', () => {
    expect((findKid(data, 'sofia') as { id: string }).id).toBe('mem_s');
    expect((findKid(data, "Mateo's") as { id: string }).id).toBe('mem_m');
    expect((findKid(data, 'Marisol') as { error: string }).error).toMatch(/Sofia and Mateo/); // a parent is not a kid
    expect((findKid(data, 'Matteo') as { id: string }).id).toBe('mem_m'); // what speech recognition writes
    expect((findKid(data, 'Sophia') as { id: string }).id).toBe('mem_s');
    expect('error' in findKid(data, 'Max')).toBe(true);
  });

  it('reads chores and jars', () => {
    const r = getKids.run({}, ctx().c) as { kids: { name: string; jar_balance: number; open_chores: unknown[] }[] };
    expect(r.kids.map((k) => [k.name, k.jar_balance, k.open_chores.length])).toEqual([['Sofia', 42.5, 1], ['Mateo', 0, 0]]);
  });

  it('writes nothing until the caller confirmed', async () => {
    const { c, calls } = ctx();
    const r = (await addKidChore.run({ kid_name: 'Sofia', chore: 'Clean your room', reward: 5, confirmed: false }, c)) as { done: boolean };
    expect(r.done).toBe(false);
    expect(calls).toEqual([]);
  });

  it('adds a chore and a deposit once confirmed', async () => {
    const { c, calls } = ctx();
    expect(await addKidChore.run({ kid_name: 'Sofia', chore: 'Clean your room', reward: 5, confirmed: true }, c)).toMatchObject({ done: true, kid: 'Sofia', reward: 5 });
    expect(await addToKidJar.run({ kid_name: 'sofia', amount: 20, confirmed: true }, c)).toMatchObject({ done: true, added: 20, new_balance: 62.5 });
    expect(calls).toEqual([['task', 'mem_s', 'Clean your room', 5], ['jar', 'mem_s', 20]]);
  });

  it('caps amounts by voice and refuses to write outside a call', async () => {
    expect(addToKidJar.schema.safeParse({ kid_name: 'Sofia', amount: 5000, confirmed: true }).success).toBe(false);
    expect(addKidChore.schema.safeParse({ kid_name: 'Sofia', chore: 'Mow', reward: 500, confirmed: true }).success).toBe(false);
    await expect(addToKidJar.run({ kid_name: 'Sofia', amount: 10, confirmed: true }, ctx(false).c)).rejects.toThrow(/only possible on a call/);
  });
});
