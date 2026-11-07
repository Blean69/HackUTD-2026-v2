/** Product name lives in exactly one place. Rename freely. */
export const PRODUCT_NAME = "Keystone";

export const PITCH =
  "One live room where a family and a team of Nemotron agents see the whole financial picture together — and every AI decision is in plain view.";

/** The shared demo room everyone can join. */
export const DEMO_HOUSEHOLD_ID = "hh_rivera";

export const SANDBOX_NOTE = "Private sandbox with synthetic data — nothing here is real money or real people.";

export const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000";
export const SPACETIME_DB = process.env.NEXT_PUBLIC_SPACETIME_DB ?? "keystone";
export const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8787";
export const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === "1";
