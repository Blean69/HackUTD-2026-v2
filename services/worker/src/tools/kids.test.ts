import { describe, expect, it } from 'vitest';
import { toolCtx } from '../testing/fake_act.js';
import type { HouseholdData } from '../types.js';
import { addKidChore, addToKidJar, approveKidChore, findKid, getKids, setKidGoal } from './kids.js';

const data = {
  members: [
    { id: 'mem_p', household_id: 'hh', name: 'Marisol Rivera', age: 38, role: 'parent', income_annual: 72000 },
    { id: 'mem_s', household_id: 'hh', name: 'Sofia Rivera', age: 15, role: 'child', income_annual: 0 },
    { id: 'mem_m', household_id: 'hh', name: 'Mateo Rivera', age: 9, role: 'child', income_annual: 0 },
  ],
  kid_jars: [{ member_id: 'mem_s', balance: 42.5, earned_total: 60, goal_title: 'Concert tickets', goal_target: 120 }],
  kid_tasks: [
    { id: 'kt1', member_id: 'mem_s', title: 'Walk the dog', reward: 5, status: 'open' },
    { id: 'kt2', member_id: 'mem_s', title: 'Clean your room', reward: 8, status: 'done' },
    { id: 'kt3', member_id: 'mem_s', title: 'Wash the car', reward: 12, status: 'done' },
    { id: 'kt4', member_id: 'mem_m', title: 'Feed the fish', reward: 2, status: 'done' },
    { id: 'kt5', member_id: 'mem_m', title: 'Big yard project', reward: 150, status: 'done' },
  ],
} as unknown as HouseholdData;

function ctx(withAct = true) {
  // the fake act records every write; the real session also waits 2.5 s between the question and the yes, here any earlier proposal counts
  const { ctx: c, calls } = toolCtx(data, withAct);
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

  it('a first "confirmed" call only asks: the model cannot skip the spoken yes', async () => {
    const { c, calls } = ctx();
    expect(await addToKidJar.run({ kid_name: 'Mateo', amount: 20, confirmed: true }, c)).toMatchObject({ done: false, ask: "Add $20.00 to Mateo's jar?" });
    expect(calls).toEqual([]);
  });

  it('adds a chore and a deposit once proposed and then confirmed', async () => {
    const { c, calls } = ctx();
    expect(await addKidChore.run({ kid_name: 'Sofia', chore: 'Clean your room', reward: 5, confirmed: false }, c)).toMatchObject({ done: false, ask: 'Add "Clean your room" for Sofia, $5.00?' });
    expect(await addKidChore.run({ kid_name: 'Sofia', chore: 'Clean her room', reward: 5, confirmed: true }, c)).toMatchObject({ done: true, kid: 'Sofia', reward: 5 });
    await addToKidJar.run({ kid_name: 'sofia', amount: 20, confirmed: false }, c);
    expect(await addToKidJar.run({ kid_name: 'sofia', amount: 20, confirmed: true }, c)).toMatchObject({ done: true, added: 20, new_balance: 62.5 });
    expect(await addToKidJar.run({ kid_name: 'sofia', amount: 25, confirmed: true }, c)).toMatchObject({ done: false }); // a different amount needs its own yes
    expect(calls).toEqual([['task', 'mem_s', 'Clean her room', 5], ['jar', 'mem_s', 20]]);
  });

  it('caps amounts by voice and refuses to write outside a call', async () => {
    expect(addToKidJar.schema.safeParse({ kid_name: 'Sofia', amount: 5000, confirmed: true }).success).toBe(false);
    expect(addKidChore.schema.safeParse({ kid_name: 'Sofia', chore: 'Mow', reward: 500, confirmed: true }).success).toBe(false);
    await expect(addToKidJar.run({ kid_name: 'Sofia', amount: 10, confirmed: true }, ctx(false).c)).rejects.toThrow(/only possible on a call/);
  });

  it('a spent yes cannot write twice: the same confirmed call asks again', async () => {
    const { c, calls } = ctx();
    await addToKidJar.run({ kid_name: 'Sofia', amount: 20, confirmed: false }, c);
    await addToKidJar.run({ kid_name: 'Sofia', amount: 20, confirmed: true }, c);
    expect(await addToKidJar.run({ kid_name: 'Sofia', amount: 20, confirmed: true }, c)).toMatchObject({ done: false, ask: expect.any(String) });
    expect(calls).toEqual([['jar', 'mem_s', 20]]);
  });
});

describe('Brian approves finished chores and sets a savings goal', () => {
  it('approve_kid_chore asks first, names the chore by words, and pays once', async () => {
    const { c, calls } = ctx();
    // Sofia has two chores waiting: without words for the chore it asks which, and nothing is written
    expect(await approveKidChore.run({ kid_name: 'Sofia', confirmed: false }, c)).toMatchObject({ done: false, note: expect.stringMatching(/Which chore.*Clean your room.*Wash the car/) });
    expect(await approveKidChore.run({ kid_name: 'sophia', chore: 'the car wash', confirmed: true }, c)).toMatchObject({ done: false, ask: 'Approve "Wash the car" for Sofia and pay $12.00 into the jar?' }); // a "confirmed" first call only asks
    expect(calls).toEqual([]);
    expect(await approveKidChore.run({ kid_name: 'Sofia', chore: 'wash car', confirmed: true }, c)).toMatchObject({ done: true, chore: 'Wash the car', paid: 12, new_balance: 54.5 });
    expect(calls).toEqual([['approve', 'kt3']]);
    // the yes was used up: the same call again asks again instead of paying twice
    expect(await approveKidChore.run({ kid_name: 'Sofia', chore: 'wash car', confirmed: true }, c)).toMatchObject({ done: false, ask: expect.any(String) });
    expect(calls).toHaveLength(1);
  });

  it('approve_kid_chore: one waiting chore needs no words; big rewards, unknown chores and unknown kids are refused with a reason', async () => {
    const { c, calls } = ctx();
    expect(await approveKidChore.run({ kid_name: 'Mateo', chore: 'fish', confirmed: false }, c)).toMatchObject({ ask: 'Approve "Feed the fish" for Mateo and pay $2.00 into the jar?' });
    expect(await approveKidChore.run({ kid_name: 'Mateo', chore: 'yard', confirmed: true }, c)).toMatchObject({ done: false, note: expect.stringMatching(/more than Brian approves by voice/) });
    expect(await approveKidChore.run({ kid_name: 'Mateo', chore: 'unicorn', confirmed: false }, c)).toMatchObject({ done: false, note: expect.stringMatching(/No chore matching "unicorn"/) });
    expect(await approveKidChore.run({ kid_name: 'Max', confirmed: false }, c)).toMatchObject({ done: false, note: expect.stringMatching(/Sofia and Mateo/) });
    expect(calls).toEqual([]);
    await expect(approveKidChore.run({ kid_name: 'Sofia', confirmed: true }, ctx(false).c)).rejects.toThrow(/only possible on a call/);
  });

  it('set_kid_goal: confirm first, says what it replaces, capped, and a new target needs its own yes', async () => {
    const { c, calls } = ctx();
    expect(await setKidGoal.run({ kid_name: 'Sofia', goal: 'Bike', target: 300, confirmed: false }, c)).toMatchObject({ done: false, ask: 'Set Sofia\'s savings goal to "Bike", $300, replacing "Concert tickets"?' });
    expect(await setKidGoal.run({ kid_name: 'Sofia', goal: 'Bike', target: 350, confirmed: true }, c)).toMatchObject({ done: false });
    expect(calls).toEqual([]);
    expect(await setKidGoal.run({ kid_name: 'Sofia', goal: 'Bike', target: 300, confirmed: true }, c)).toMatchObject({ done: true, kid: 'Sofia', goal: 'Bike', target: 300, saved_so_far: 42.5 });
    expect(calls).toEqual([['kidgoal', 'mem_s', 'Bike', 300]]);
    expect(await setKidGoal.run({ kid_name: 'Mateo', goal: 'Lego set', target: 60, confirmed: false }, c)).toMatchObject({ ask: 'Set Mateo\'s savings goal to "Lego set", $60.00?' });
    expect(setKidGoal.schema.safeParse({ kid_name: 'Sofia', goal: 'Car', target: 20000, confirmed: true }).success).toBe(false);
    expect(setKidGoal.schema.safeParse({ kid_name: 'Sofia', goal: 'Car', target: 0, confirmed: true }).success).toBe(false);
  });
});
