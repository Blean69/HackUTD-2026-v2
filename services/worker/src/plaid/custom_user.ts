// The demo bank: a Plaid Sandbox CUSTOM USER (checking, savings, card, mortgage, auto loan, IRA, CD and about six months of
// transactions), defined in data/plaid/sandbox_user.json. /sandbox/public_token/create takes it as
// options.override_username = "user_custom" and options.override_password = <that JSON as a string>.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PKG_ROOT } from '../config.js';

export const CUSTOM_SANDBOX_USER = 'user_custom';

/** PLAID_SANDBOX_USER_FILE, else <DATA_DIR>/../plaid/sandbox_user.json (DATA_DIR defaults to ../../data/seed). */
export function sandboxUserPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.PLAID_SANDBOX_USER_FILE ?? '').trim();
  if (explicit) return resolve(PKG_ROOT, explicit);
  return resolve(PKG_ROOT, (env.DATA_DIR ?? '').trim() || '../../data/seed', '..', 'plaid', 'sandbox_user.json');
}

/** The custom user as the compact JSON string Plaid expects in override_password, or null when the file is missing or invalid. */
export function loadSandboxUserJson(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sandboxUserPath(env), 'utf8'));
    return parsed && typeof parsed === 'object' ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}
