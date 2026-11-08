import { describe, expect, it } from 'vitest';
import { unbackedFigures } from './grounding.js';

const accounts = { accounts: [{ nickname: 'Rewards Visa', balance: 1558.81, rate_pct: 21.99, monthly_payment: 35 }, { nickname: "Daniel's F-150 Loan", balance: 19800, rate_pct: 5.9 }], totals: { liquid_cash: 40109.07 } };
const health = [{ key: 'savings_rate', value: 8.8, explanation: '$13,363 a month in vs $12,186 out leaves $1,177 a month, 8.8% of income.' }];

describe('unbackedFigures (Ask grounding)', () => {
  it('passes figures copied or rounded from the tool results', () => {
    expect(unbackedFigures('Your Rewards Visa owes $1,559 at 21.99%; the truck loan is $19.8k at 5.9%. You keep about 9% ($1,177 a month).', [accounts, health])).toEqual([]);
  });

  it('flags invented figures and "typical" rates', () => {
    expect(unbackedFigures('Card rates are typically 15-25% and you save $2,337 a month (17.9%).', [accounts, health])).toEqual(['$2,337', '25%', '17.9%']);
  });

  it('numbers the user asked about are fair to repeat', () => {
    expect(unbackedFigures('Paying $5,000 toward the card would clear it.', [accounts], 'what if we put $5,000 on the card?')).toEqual([]);
  });
});

describe('Table Mode guardrails', () => {
  it('never scores gambling or "double our crypto" as a plan', async () => {
    const { riskyGoal } = await import('./huddle.js');
    expect(riskyGoal("Double crypto through gambling Well, I'm gonna gamble the crypto, we're gonna double it")?.why).toMatch(/Gambling is not a plan/);
    expect(riskyGoal('Buy $500 in crypto')?.why).toMatch(/speculative/);
    expect(riskyGoal('Win the lottery')).not.toBeNull();
    expect(riskyGoal('Second bakery location')).toBeNull();
    expect(riskyGoal("Sofia's college fund")).toBeNull();
    expect(riskyGoal('Pay off the Visa by March')).toBeNull();
  });

  it('the scam guard does not read "wireless" as a wire transfer', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../tools/scam.ts', import.meta.url), 'utf8');
    const re = eval(src.match(/PAYMENT_MERCHANT = (\/.*\/[a-z]*);/)![1]!) as RegExp;
    expect(re.test('AT&T family wireless plan')).toBe(false);
    expect(re.test('Wire transfer to J. Smith')).toBe(true);
    expect(re.test('Western Union')).toBe(true);
  });
});
