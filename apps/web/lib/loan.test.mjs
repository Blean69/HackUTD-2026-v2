// node --test lib/loan.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { minPayment, payoff } from "./loan.ts";

test("loan math", () => {
  assert.deepEqual(payoff(1200, 0, 100), { months: 12, interest: 0 });
  assert.equal(payoff(10000, 6, 40), null); // $50 of interest a month swallows a $40 payment
  const slow = payoff(30000, 5.5, minPayment(30000, 5.5, 10));
  const fast = payoff(30000, 5.5, minPayment(30000, 5.5, 10) + 200);
  assert.ok(Math.abs(slow.months - 120) <= 1);
  assert.ok(fast.months < slow.months && fast.interest < slow.interest);
});
