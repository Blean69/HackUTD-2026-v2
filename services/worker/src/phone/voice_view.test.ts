import { describe, expect, it } from 'vitest';
import { humanMoney, humanMonths, humanPercent, voiceView } from './voice_view.js';

describe('voice view rounding (numbers the way people say them)', () => {
  it('rounds dollars like a person: thousands from 10k, hundreds from 1k, round $50s stay', () => {
    expect(humanMoney(39655.4)).toBe(40000);
    expect(humanMoney(12186)).toBe(12000);
    expect(humanMoney(35000)).toBe(35000);
    expect(humanMoney(7744)).toBe(7700);
    expect(humanMoney(1850)).toBe(1850); // rent stays exact
    expect(humanMoney(612)).toBe(612);
    expect(humanMoney(88.4)).toBe(88);
    expect(humanMoney(-4812.33)).toBe(-4800);
    expect(humanMoney(Number.NaN)).toBe(0);
    expect(humanMoney('x')).toBe(0);
  });

  it('rounds percentages: whole from 10, halves below', () => {
    expect(humanPercent(8.8)).toBe(9);
    expect(humanPercent(97.7)).toBe(98);
    expect(humanPercent(3.2)).toBe(3);
    expect(humanPercent(6.25)).toBe(6.5);
  });

  it('months: halves under a month, one decimal to ten, then whole', () => {
    expect(humanMonths(0.4)).toBe(0.5);
    expect(humanMonths(0.1)).toBe(0);
    expect(humanMonths(3.31)).toBe(3.3);
    expect(humanMonths(19.6)).toBe(20);
    expect(humanMonths(undefined)).toBe(0);
  });

  it('health indicators come out rounded; months keep one decimal', () => {
    const v = voiceView('get_health_indicators', {
      indicators: [
        { label: 'Liquidity runway', value: 3.31, unit: 'months', status: 'watch', explanation: 'x' },
        { label: 'Savings rate', value: 8.8, unit: '%', status: 'watch', explanation: 'x' },
        { label: 'Cash', value: 40109.2, unit: 'USD', status: 'good', explanation: 'x' },
        { label: 'Emergency fund', value: 35700, unit: 'usd', status: 'watch', explanation: 'x' },
      ],
    }) as { indicators: { value: number }[] };
    expect(v.indicators.map((i) => i.value)).toEqual([3.3, 9, 40000, 36000]);
  });

  it('forecast and scenario dollars are rounded at the source', () => {
    const f = voiceView('get_forecast', { available: true, start: { balance: 40182.6, date: '2026-11-07' }, end: { balance: 42837.1, date: '2027-02-05' }, lowest: { balance: 39655.4, date: '2026-11-24' }, obligations_due_total: 7744 }) as Record<string, any>;
    expect(f.lowest.balance).toBe(40000);
    expect(f.starting_balance).toBe(40000);
    expect(f.ending_balance).toBe(43000);
    expect(f.bills_due_total).toBe(7700);
  });
});

describe('bill due dates are said like a person would', () => {
  it('names the next date a bill falls due, rolling into next month and clamping to its length', async () => {
    const { nextDueLabel } = await import('../util.js');
    expect(nextDueLabel(9, '2026-11-07')).toBe('November 9');
    expect(nextDueLabel(7, '2026-11-07')).toBe('November 7'); // due today
    expect(nextDueLabel(3, '2026-11-07')).toBe('December 3');
    expect(nextDueLabel(31, '2026-11-07')).toBe('November 30');
    expect(nextDueLabel(2, '2026-12-20')).toBe('January 2');
    expect(nextDueLabel(12, 'not a date')).toBe('the 12th');
  });

  it('the phone view of get_obligations carries "due", never a bare day number', () => {
    const v = voiceView('get_obligations', { count: 1, monthly_total: 612, obligations: [{ name: 'Car loan', amount: 612.4, due_day: 12, kind: 'loan' }] }, '2026-11-07') as { biggest: Record<string, unknown>[] };
    expect(v.biggest[0]).toEqual({ name: 'Car loan', amount: 612, due: 'November 12', kind: 'loan' });
  });
});
