import { afterEach, describe, expect, it } from 'vitest';
import { getPlaidRuntime, resetPlaidRuntime } from './runtime.js';

afterEach(() => {
  delete process.env.PLAID_QUIET_POLLS;
  delete process.env.PLAID_POLL_ATTEMPTS;
  resetPlaidRuntime();
});

describe('Plaid runtime polling defaults', () => {
  it('waits for three quiet polls (Plaid delivers a 170-row custom user in several batches) and up to 15 polls', () => {
    resetPlaidRuntime();
    expect(getPlaidRuntime()).toMatchObject({ quietPolls: 3, pollAttempts: 15, pollMs: 3000 });
  });
  it('is overridable from the environment', () => {
    process.env.PLAID_QUIET_POLLS = '1';
    process.env.PLAID_POLL_ATTEMPTS = '10';
    resetPlaidRuntime();
    expect(getPlaidRuntime()).toMatchObject({ quietPolls: 1, pollAttempts: 10 });
  });
});
