/** Product name lives in exactly one place. */
export const PRODUCT_NAME = "Cosign";

export const PITCH =
  "A shared financial room for the whole household: one live picture of your money, with every AI decision in plain view.";

/** The shared demo room everyone can join. */
export const DEMO_HOUSEHOLD_ID = "hh_rivera";

export const SANDBOX_NOTE = "Private copy with synthetic data. Nothing here is real money or real people.";
export const SYNTHETIC_NOTE = "All data in this demo is synthetic. Nothing here is real money or real people.";
export const CHALLENGE_NOTE = "Built for the PNC 360° Financial Health Navigator challenge · HackUTD 2026";

export const SPACETIME_URI = process.env.NEXT_PUBLIC_SPACETIME_URI ?? "ws://localhost:3000";
export const SPACETIME_DB = process.env.NEXT_PUBLIC_SPACETIME_DB ?? "keystone";
export const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8787";
export const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === "1";
