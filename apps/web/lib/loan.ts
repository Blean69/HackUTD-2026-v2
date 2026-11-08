/** Student-loan math for Teen mode. Monthly compounding; the last payment is whatever is left. */
export interface Payoff { months: number; interest: number }

/** Months and total interest to clear `balance` at `aprPct` paying `monthly`; null if the payment never beats the interest. */
export function payoff(balance: number, aprPct: number, monthly: number): Payoff | null {
  const r = aprPct / 1200;
  if (balance <= 0) return { months: 0, interest: 0 };
  if (monthly <= balance * r) return null;
  let bal = balance, interest = 0, months = 0;
  while (bal > 0.005 && months < 1200) {
    const i = bal * r;
    interest += i;
    bal = bal + i - Math.min(monthly, bal + i);
    months++;
  }
  return { months, interest };
}

/** Standard amortised payment for a loan over `years`. */
export function minPayment(balance: number, aprPct: number, years = 10): number {
  const r = aprPct / 1200, n = years * 12;
  return r === 0 ? balance / n : (balance * r) / (1 - Math.pow(1 + r, -n));
}
